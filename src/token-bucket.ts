import redBlackTree from 'functional-red-black-tree';
import { performance } from 'just-performance';
import { CanceledError, DefaultScheduler, TeardownCallback, TimeoutScheduler, VoidCallback } from './models';
import { ContinuousTokenRestorer, DiscreteTokenRestorer, TokenRestorer } from './token-restorers';

export interface TokenBucketOptions {
    /** The number of tokensthe bucket starts with. */
    readonly initialTokens: number;

    /** The maximum number of tokens that can be stored in the bucket. */
    readonly maxTokens?: number;

    /** Timer implementation. */
    readonly scheduler?: TimeoutScheduler;
}

export class TokenBucket {
    constructor(options: TokenBucketOptions) {
        if (!Number.isFinite(options.initialTokens) || options.initialTokens < 0) {
            throw new Error('initialTokens must be positive finite number, or zero.');
        } else if (options.maxTokens != null && (Number.isNaN(options.maxTokens) || options.maxTokens < 0)) {
            throw new Error('maxTokens must be positive, or zero.');
        }

        this._maxTokens = options.maxTokens ?? Number.POSITIVE_INFINITY;
        this._tokenContent = Math.min(options.initialTokens, this._maxTokens);
        this._scheduler = options.scheduler ?? DefaultScheduler;
    }

    /** Timer implementation. */
    protected readonly _scheduler: TimeoutScheduler;

    /** How many tokens are currently present in the bucket. */
    protected _tokenContent: number;

    /** The maximum number of tokens that can be stored in the bucket. */
    protected readonly _maxTokens: number;

    /** A collection of installed continuous token restorers. */
    protected readonly _continuousTokenRestorers = new Set<ContinuousTokenRestorer>();

    /** The aggregate continuous restoration rate. */
    protected _continuousRestoreRatePerMs = 0;

    /** The last time continuous restoration was performed. */
    protected _continuousRestoreLastTimestamp = 0;

    /** A collection of installed discrete token restorers and their teardown callbacks. */
    protected readonly _discreteTokenRestorers = new Map<DiscreteTokenRestorer, TeardownCallback>();

    /**
     * A sorted binary tree of listeners.
     * 
     * - Collection key is the requested token count.
     * - Collection value is the listener's promise resolve function.
     */
    protected _tokenListeners = redBlackTree<number, VoidCallback>();

    /** Handle of a timer that wakes up awaiters once there are enough tokens available. */
    protected _checkListenersHandle: any;

    addTokenRestorer(restorer: TokenRestorer): boolean {
        if (restorer instanceof ContinuousTokenRestorer) {
            if (!this._continuousTokenRestorers.has(restorer)) {
                this._addOrRemoveContinuousRestorer(restorer, true);

                return true;
            } else {
                return false;
            }
        } else if (restorer instanceof DiscreteTokenRestorer) {
            if (!this._discreteTokenRestorers.has(restorer)) {
                this._discreteTokenRestorers.set(
                    restorer,
                    restorer.subscribe(
                        count => {
                            this._addTokensToBucket(count);
                            this._checkListeners();
                        },
                    ),
                );

                return true;
            } else {
                return false;
            }
        }
        
        throw new Error('Restorer not supported.');
    }

    removeTokenRestorer(restorer: TokenRestorer): boolean {
        if (restorer instanceof ContinuousTokenRestorer) {
            if (this._continuousTokenRestorers.has(restorer)) {
                this._addOrRemoveContinuousRestorer(restorer, false);

                return true;
            } else {
                return false;
            }
        } else if (restorer instanceof DiscreteTokenRestorer) {
            const unsubscribe = this._discreteTokenRestorers.get(restorer);

            if (unsubscribe != null) {
                // Remove the restorer from our collection
                this._discreteTokenRestorers.delete(restorer);

                // Unsubscribe from the restorer
                unsubscribe();

                return true;
            } else {
                return false;
            }
        }
        
        throw new Error('Restorer not supported.');
    }

    /** Remove all token restorers. */
    disconnectRestorers(): void {
        // Remove continuous restorers
        this._restoreContinuousTokens();
        this._continuousTokenRestorers.clear();
        this._continuousRestoreRatePerMs = 0;
        
        // Reschedule timers because the aggregate continuous restoration rate changed
        this._scheduleCheckListeners();

        // Remove discrete restorers
        for (const [restorer, teardown] of [...this._discreteTokenRestorers.entries()]) {
            this._discreteTokenRestorers.delete(restorer);
            teardown();
        }
    }

    /**
     * Consume specified number of tokens from the bucket.
     * @param count The number of tokens to consume.
     * @returns `true` if tokens were consumed. `false` if there were not enough tokens in the bucket.
     */
    consumeTokens(count: number): boolean {
        if (count < 0) {
            throw new Error('Cannot consume negative number of tokens!');
        } else if (count <= this._getConsumableTokens()) {
            this._tokenContent -= count;
            this._onTokensConsumed(count);
            return true;
        } else {
            return false;
        }
    }

    /**
     * Returns a promise that resolves once the specified number of tokens is available in the bucket.
     * @param count The number of tokens to wait for.
     * @returns A promise and a cancellation callback. If you invoke the cancellation callback, the promise will be removed from internal collection and rejected.
     */
    onceTokensAvailable(count: number): { promise: Promise<void>, cancel: VoidCallback } {
        if (count > this._maxTokens) {
            throw new Error(`Cannot wait for ${count} tokens because max bucket capacity is ${this._maxTokens}!`);
        }

        let cancel!: VoidCallback;

        const promise = new Promise<void>((resolve, reject) => {
            // Add listener to the collection
            this._tokenListeners = this._tokenListeners.insert(count, resolve);

            // Check if we can resolve the listener immediately
            this._checkListeners();

            cancel = () => {
                for (let iter = this._tokenListeners.find(count); iter.key === count; iter.next()) {
                    if (iter.value === resolve) {
                        this._tokenListeners = iter.remove();
                        this._scheduleCheckListeners();
                        reject(new CanceledError());
                        break;
                    }
                }
            };
        });

        return { promise, cancel };
    }

    /**
     * Waits until there are enough tokens available in the bucket, then consumes them.
     * @param count The number of tokens to consume.
     */
    consumeTokensAsync(count: number): { promise: Promise<void>, cancel: VoidCallback } {
        let shouldCancel = false;
        let cancelWait: VoidCallback | undefined;

        return {
            promise: (async () => {
                if (shouldCancel) {
                    throw new CanceledError();
                }
    
                while (!this.consumeTokens(count)) {
                    const { promise, cancel } = this.onceTokensAvailable(count);
                    
                    try {
                        cancelWait = cancel;
                        await promise;
                    } finally {
                        cancelWait = undefined;
                    }
                    
                    if (shouldCancel) {
                        throw new CanceledError();
                    }
                }
            })(),
            cancel: () => {
                shouldCancel = true;
                cancelWait?.();
            },
        };
    }

    protected _onTokensConsumed(_count: number): void {
        // Need to reschedule timers because available tokens changed.
        // Eg. another listener may have been waiting for 40 tokens, but we
        // just consumed 5 and left 10 in the bucket (instead of 15). So the 40-listener
        // will now need to wait longer!
        this._scheduleCheckListeners();
    }

    /** Restore tokens using continuous token restorers. */
    protected _restoreContinuousTokens(): void {
        // Current timestamp
        const now = performance.now();

        // Restore tokens
        const tokenCount = this._continuousRestoreRatePerMs * (now - this._continuousRestoreLastTimestamp);
        this._addTokensToBucket(tokenCount);
        
        // Update last-used timestamp
        this._continuousRestoreLastTimestamp = now;
    }

    protected _addTokensToBucket(tokenCount: number): void {
        // Update token count
        this._tokenContent += tokenCount;
        
        // Clamp token count
        if (this._tokenContent > this._maxTokens) {
            this._tokenContent = this._maxTokens;
        }
    }

    protected _getConsumableTokens(): number {
        this._restoreContinuousTokens();
        return this._tokenContent;
    }

    /**
     * Resolves listeners waiting for tokens, and schedules next check.
     */
    protected _checkListeners(): void {
        if (this._tokenListeners.length > 0) {
            // Get the current amount of tokens ready to be consumed
            const consumableTokens = this._getConsumableTokens();

            // Loop over the listeners, starting from the ones asking for the least amount of tokens, and notify them of available tokens
            for (let iter = this._tokenListeners.begin; iter.valid && iter.key! <= consumableTokens; iter = this._tokenListeners.begin) {
                // Resolve the listener's promise
                iter.value!();

                // Remove the listener from collection
                this._tokenListeners = iter.remove();
            }
        }
        
        // Wait until there are more tokens available, then check again
        this._scheduleCheckListeners();
    }

    protected _getWaitTimeForRecheck(): number {
        // Get the smallest number of tokens requested by a listener
        const minTokenCount = this._tokenListeners.begin.key ?? Number.POSITIVE_INFINITY;

        // How many more tokens we need to satisfy the listener's demand
        this._restoreContinuousTokens();
        const missingTokenCount = Math.max(0, minTokenCount - this._tokenContent);
        
        // The amount of time (in milliseconds) it takes to restore the specified number of tokens using continuous restorers
        return missingTokenCount / this._continuousRestoreRatePerMs;
    }

    protected _scheduleCheckListeners(): void {
        if (this._checkListenersHandle != null) {
            this._scheduler.clearTimeout(this._checkListenersHandle);
            this._checkListenersHandle = undefined;
        }

        if (this._tokenListeners.length > 0) {
            const waitTime = this._getWaitTimeForRecheck();

            if (Number.isFinite(waitTime)) {
                if (waitTime <= 0) {
                    this._checkListeners();
                } else {
                    this._checkListenersHandle = this._scheduler.setTimeout(
                        () => this._checkListeners(),
                        waitTime,
                    );
                }
            }
        }
    }

    protected _addOrRemoveContinuousRestorer(restorer: ContinuousTokenRestorer, add: boolean): void {
        // Refill tokens using existing restorers
        this._restoreContinuousTokens();

        // Add/remove the restorer to/from our collection
        if (add) {
            this._continuousTokenRestorers.add(restorer);
        } else {
            this._continuousTokenRestorers.delete(restorer);
        }

        // Recompute aggregate continuous restoration rate
        this._continuousRestoreRatePerMs = ContinuousTokenRestorer.computeAggregateRatePerMs(this._continuousTokenRestorers);
        
        // Reschedule timers because the aggregate continuous restoration rate changed
        this._scheduleCheckListeners();
    }
}