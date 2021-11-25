import Denque from 'denque';
import redBlackTree from 'functional-red-black-tree';
import { performance } from 'just-performance';
import { CanceledError, DefaultScheduler, ErrorCallback, TimeoutScheduler, VoidCallback } from './models';
import { TokenBucket } from './token-bucket';

const cancellationError = {};
function noop(): void { }

interface Awaiter {
    /** How many tokens the awaiter asked for. */
    tokenCount: number;

    /** Callback to resolve the awaiter's promise. */
    resolve: VoidCallback;

    /** Callback to reject the awaiter's promise. */
    reject: ErrorCallback;
}

export interface PrioritizedFifoRateLimiterOptions {
    readonly tokenBucket: TokenBucket,

    /** How long to wait after launching a job before launching another one. Value in milliseconds. */
    readonly minStaggerTime?: number;
    
    /** Timer implementation. */
    readonly scheduler?: TimeoutScheduler;
}

/** Rate limiter scheduling tasks using priority and FIFO queue. */
export class PrioritizedFifoRateLimiter {
    constructor(options: PrioritizedFifoRateLimiterOptions) {
        this._tokenBucket = options.tokenBucket;
        this._minStaggerTime = options.minStaggerTime ?? 0;
        this._scheduler = options.scheduler ?? DefaultScheduler;
    }

    private readonly _tokenBucket: TokenBucket;
    private readonly _minStaggerTime: number;
    private readonly _scheduler: TimeoutScheduler;
    
    /**
     * A collection of awaiters, grouped by priority.
     * - Collection keys are awaiter priorities
     * - Collection values are awaiters
     */
    private _awaiters = redBlackTree<number, Denque<Awaiter>>();
    
    /** Token watcher instance. */
    private _watcher: {
        promise: Promise<void>;
        cancel: VoidCallback;
    } | undefined;

    /** Timestamp of the last time tokens were consumed. */
    private _lastConsumed = Number.NEGATIVE_INFINITY;

    consumeTokensAsync(tokenCount: number, priority: number): { promise: Promise<void>, cancel: VoidCallback } {
        let cancel!: VoidCallback;

        const promise = new Promise<void>((resolve, reject) => {
            const newAwaiter: Awaiter = { tokenCount, resolve, reject };
            this._addAwaiter(priority, newAwaiter);

            cancel = () => {
                if (this._removeFirstAwaiter(priority, awaiter => awaiter === newAwaiter)) {
                    this._recreateWatcher();
                    reject(new CanceledError());
                }
            };
        });

        this._recreateWatcher();
        return { promise, cancel };
    }

    /**
     * Restore the specified number of tokens.
     * @param count The number of tokens to restore.
     */
    restoreTokens(count: number): void {
        this._tokenBucket.restoreTokens(count);
    }

    private _recreateWatcher(): void {
        // Get previous watcher
        let prevWatcher = this._watcher;

        // Create a new promise, used to signal watcher cancellation
        let rejectCancel!: ErrorCallback;
        const cancelPromise = new Promise<never>((_resolve, reject) => {
            rejectCancel = reject;
        });

        // Create watcher promise, used to propagate errors and signal completion
        let resolveWatcher!: VoidCallback;
        let rejectWatcher!: ErrorCallback;
        const watcherPromise = new Promise<void>((resolve, reject) => {
            resolveWatcher = resolve;
            rejectWatcher = reject;
        });

        // Create a new watcher reference
        const currentWatcher = this._watcher = {
            promise: watcherPromise,
            cancel: () => {
                // Avoid error allocation to ease memory pressure
                rejectCancel(cancellationError);
            },
        };

        (async () => {
            try {
                if (prevWatcher) {
                    try {
                        // Cancel previous watcher
                        prevWatcher.cancel();

                        // Wait for the watcher to finish
                        await prevWatcher.promise;
                    } catch (error) {
                        if (error !== cancellationError && !(error instanceof CanceledError)) {
                            throw error;
                        }
                    } finally {
                        // Release the captured reference so it can be garbage-collected
                        prevWatcher = undefined;
                    }
                }

                // Create a stagger delay
                const { promise: delayPromise, cancel: cancelDelay } = this._delay(
                    this._lastConsumed + this._minStaggerTime - performance.now(),
                );

                // Stagger awaiters
                try {
                    await Promise.race([
                        cancelPromise,
                        delayPromise,
                    ]);
                } finally {
                    // Aid GC by removing the timer
                    cancelDelay();
                }

                // Find the first highest-priority awaiter
                const { key: priority, value: queue } = this._awaiters.end;
                const awaiter = queue?.peekFront();

                if (awaiter) {
                    // Wait for token consumption
                    const { promise: consumePromise, cancel: cancelConsume } = this._tokenBucket.consumeTokensAsync(awaiter.tokenCount);
                    try {
                        // Order is important here! If the tokens were consumed, continue to resolve the
                        // awaiter even if the watcher was canceled at the same time!
                        await Promise.race([
                            consumePromise,
                            cancelPromise,
                        ]);
                    } catch (error) {
                        if (error === cancellationError || error instanceof CanceledError) {
                            cancelConsume();
                            await consumePromise;
                        }
                        
                        throw error;
                    }

                    // Remove the awaiter from the queue
                    this._removeFirstAwaiter(priority!, a => a === awaiter);

                    // Resolve the awaiter
                    this._lastConsumed = performance.now();
                    awaiter.resolve();

                    // Create watcher for the next highest-priority awaiter
                    this._recreateWatcher();
                }
                
                resolveWatcher();
            } catch (error) {
                // Check if the error was thrown without having a replacement watcher
                if (this._watcher === currentWatcher) {
                    // Propagate the error to awaiters
                    this._rejectAllAwaiters(error === cancellationError ? new CanceledError() : error);
                }

                rejectWatcher(error);
            }
        })();
    }

    private _rejectAllAwaiters(error: unknown): void {
        // Clear the collection first
        const awaiters = this._awaiters;
        this._awaiters = redBlackTree<number, Denque<Awaiter>>();

        awaiters.forEach((_priority, queue) => {
            for (let i = 0; i < queue.length; i++) {
                queue.peekAt(i)!.reject(error);
            }
        });
    }

    private _addAwaiter(priority: number, awaiter: Awaiter): void {
        const queue = this._awaiters.get(priority);

        if (queue) {
            queue.push(awaiter);
        } else {
            this._awaiters = this._awaiters.insert(
                priority,
                new Denque<Awaiter>([awaiter]),
            );
        }
    }

    private _removeFirstAwaiter(priority: number, predicate: (awaiter: Awaiter) => boolean): boolean {
        const iter = this._awaiters.find(priority);
        const queue = iter?.value;

        if (queue) {
            try {
                for (let i = 0; i < queue.length; i++) {
                    if (predicate(queue.peekAt(i)!)) {
                        queue.removeOne(i);
                        return true;
                    }
                }
            } finally {
                // Remove empty queue
                if (queue.length <= 0) {
                    this._awaiters = iter.remove();
                }
            }
        }

        return false;
    }

    private _delay(ms: number): { promise: Promise<void>, cancel: VoidCallback } {
        let promise: Promise<void>;
        let cancel!: VoidCallback;

        if (ms <= 0) {
            promise = Promise.resolve();
            cancel = noop;
        } else {
            promise = new Promise<void>((resolve, reject) => {
                const t = this._scheduler.setTimeout(resolve, ms);

                cancel = () => {
                    this._scheduler.clearTimeout(t);
                    reject(cancellationError);
                };
            });
        }
        
        return { promise, cancel };
    }
}