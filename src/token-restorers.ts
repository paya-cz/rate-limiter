import { DefaultScheduler, IntervalScheduler, Rate, RestoreTokensCallback, TeardownCallback } from './models';

export type TokenRestorer = ContinuousTokenRestorer | DiscreteTokenRestorer;

/** Continuously and linearly restore tokens over a period of time. */
export class ContinuousTokenRestorer {
    constructor(
        /** The number of tokens restored continuously, and the lenght of the period. */
        readonly rate: Rate,
    ) {
    }

    /**
     * Computes aggregate linear continuous restoration rate.
     * @param restorers A collection of continuous token restorers.
     * @returns A continuous restoration rate per millisecond.
     */
    static computeAggregateRatePerMs(restorers: Iterable<ContinuousTokenRestorer>): number {
        let amountPerMs = 0;

        for (const r of restorers) {
            amountPerMs += r.rate.amount / r.rate.intervalMs;
        }

        return amountPerMs;
    }
}


/** Restore tokens in a discrete time intervals. */
export abstract class DiscreteTokenRestorer {
    /** Called by the bucket to start listening to token restoration events. */
    abstract subscribe(restoreTokens: RestoreTokensCallback): TeardownCallback;
}

/**
 * Periodically restore tokens.
 * Uses only a single timer even when used with multiple buckets - this lets you restore tokens in multiple bucket synchronously.
 */
export class PeriodicTokenRestorer extends DiscreteTokenRestorer {
    constructor(
        /** The number of tokens restored periodically, and the lenght of the period. */
        readonly rate: Rate,

        /** Timer implementation. */
        scheduler?: IntervalScheduler,
    ) {
        super();
        this._scheduler = scheduler ?? DefaultScheduler;
    }

    private readonly _scheduler: IntervalScheduler;
    private readonly _listeners = new Set<RestoreTokensCallback>();
    private _timerHandle: any = undefined;

    subscribe(onTokensRestored: RestoreTokensCallback): TeardownCallback {
        this._listeners.add(onTokensRestored);

        if (this._timerHandle == null) {
            const { amount, intervalMs } = this.rate;

            this._timerHandle = this._scheduler.setInterval(
                () => {
                    for (const restoreTokens of this._listeners) {
                        restoreTokens(amount);
                    }
                },
                intervalMs,
            );
        }
        
        return () => {
            this._listeners.delete(onTokensRestored);

            if (this._listeners.size <= 0) {
                this._scheduler.clearInterval(this._timerHandle);
                this._timerHandle = undefined;
            }
        };
    }
}