import { BaseError } from 'make-error';

/** A function type to start a timer (interval/timeout). */
export type StartTimerDelegate<T = any> = (callback: () => void, ms: number) => T;

/** A function type to stop a timer (interval/timeout). */
export type ClearTimerDelegate<T = any> = (handle: T) => void;

/** A function type without params or return value. */
export type VoidCallback = () => void;

/** A function type to signal an error. */
export type ErrorCallback = (error: any) => void;

/** A function type to tear-down something. */
export type TeardownCallback = VoidCallback;

/** A function type to restore a given number of tokens. */
export type RestoreTokensCallback = (count: number) => void;

/** Represents a rate, such as 20 units per second. Or 3 units per millisecond. */
export interface Rate {
    /** The number of units per interval. */
    readonly amount: number,

    /** How long the interval is, in milliseconds. */
    readonly intervalMs: number,
}

/** Scheduler for interval timer. */
export interface IntervalScheduler<T = any> {
    readonly setInterval: StartTimerDelegate<T>;
    readonly clearInterval: ClearTimerDelegate<T>;
}

/** Scheduler for timeout timer. */
export interface TimeoutScheduler<T = any> {
    readonly setTimeout: StartTimerDelegate<T>;
    readonly clearTimeout: ClearTimerDelegate<T>;
}

/** Default scheduler implementation. */
export const DefaultScheduler: IntervalScheduler & TimeoutScheduler = {
    setInterval: setInterval,
    clearInterval: clearInterval,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
}

export class CanceledError extends BaseError {
    constructor() {
        super('Operation has been canceled.');
    }
}