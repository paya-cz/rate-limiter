import redBlackTree from 'functional-red-black-tree';
import { performance } from 'just-performance';
import { TokenBucket, TokenBucketOptions } from './token-bucket';

export interface RollingWindowTokenBucketOptions extends TokenBucketOptions {
    /** The number of milliseconds to look back in the past for spent tokens. */
    readonly historyIntervalMs: number;

    /** The maximum number of tokens (in total) that can be spent within the history window. */
    readonly maxHistoryTokens: number;
}

export class RollingWindowTokenBucket extends TokenBucket {
    constructor(options: RollingWindowTokenBucketOptions) {
        super(options);

        if (!Number.isFinite(options.historyIntervalMs) || options.historyIntervalMs < 0) {
            throw new Error('rollingWindowMs must be positive finite number, or zero.');
        } else if (!Number.isFinite(options.maxHistoryTokens) || options.maxHistoryTokens < 0) {
            throw new Error('maxHistoryTokens must be positive finite number, or zero.');
        }

        this._historyIntervalMs = options.historyIntervalMs;
        this._maxHistoryTokens = options.maxHistoryTokens;
    }

    private readonly _historyIntervalMs: number;
    private readonly _maxHistoryTokens: number;

    /**
     * A history (rolling window) of consumed tokens.
     * 
     * - Collection key represents the timestamp when the tokens were spent.
     * - Collection value represents how many tokens were spent at the time.
     */
    private _history = redBlackTree<number, number>();

    /** Handle of a timer that cleans up history collection. */
    private _cleanUpHandle: any;
    
    protected override _onTokensConsumed(count: number): void {
        this._history = this._history.insert(performance.now(), count);
        this._scheduleCleanUpCall();
        super._onTokensConsumed(count);
    }

    protected override _getConsumableTokens(): number {
        return Math.min(
            this._maxHistoryTokens - this._countAndCleanupHistoricTokens(),
            super._getConsumableTokens(),
        );
    }
    
    protected override _getWaitTimeForRecheck(): number {
        const restoreWaitTime = super._getWaitTimeForRecheck();

        // Clean up history, and count spent tokens
        const spentTokens = this._countAndCleanupHistoricTokens();
        const oldestHistoryTimestamp = this._history.begin.key;

        // How long to wait (in milliseconds) until the oldest token in the history expires
        const expireWaitTime = oldestHistoryTimestamp != null
            ? Math.max(0, oldestHistoryTimestamp + this._historyIntervalMs - performance.now())
            : Number.POSITIVE_INFINITY;

        // If restoreWaitTime is 0, it means one of:
        // - the tokens demanded by listeners just became available at this instant
        // - there are tokens available already, but cannot be consumed due to spent history budget
        //
        // So, let's check if the listener asking for the least amount of tokens is blocked by history budget
        if (restoreWaitTime === 0) {
            const availableTokenHistoryBudget = this._maxHistoryTokens - spentTokens;
            const minRequestedTokenCount = this._tokenListeners.begin.key ?? Number.POSITIVE_INFINITY;

            if (minRequestedTokenCount <= availableTokenHistoryBudget) {
                // The listener is not limited by history budget, so return 0 to recheck immediately
                return 0;
            } else {
                return expireWaitTime;
            }
        } else {
            return Math.min(restoreWaitTime, expireWaitTime);
        }
    }

    /** Schedules a call to clean up blocked tokens during periods of no activity. */
    private _scheduleCleanUpCall(): void {
        if (this._cleanUpHandle != null) {
            this._scheduler.clearTimeout(this._cleanUpHandle);
            this._cleanUpHandle = undefined;
        }

        if (this._history.length > 0) {
            this._cleanUpHandle = this._scheduler.setTimeout(
                () => this._cleanupHistoricTokens(),
                this._historyIntervalMs + 100,
            );
        }
    }
    
    /** Cleans up expired entries in the history, then counts the total of tokens in history. */
    private _countAndCleanupHistoricTokens(): number {
        this._cleanupHistoricTokens();

        let total = 0;

        this._history.forEach((_key, value) => {
            total += value;
        });

        return total;
    }

    private _cleanupHistoricTokens(): void {
        const expiryTimestamp = performance.now() - this._historyIntervalMs;

        // Remove all expired entries
        for (let entry = this._history.begin; entry.valid && entry.key! < expiryTimestamp; entry = this._history.begin) {
            this._history = entry.remove();
        }
    }
}
