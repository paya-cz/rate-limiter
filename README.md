# rate-limiter

A rate limiter that helps you limit your client from making excessive API requests.
Written in TypeScript and compatible with both Node.js and browsers.

## Installation

With [npm](https://www.npmjs.com/) do:

    $ npm install @mangosteen/rate-limiter

## Why not use [limiter](https://www.npmjs.com/package/limiter) or [bottleneck](https://www.npmjs.com/package/limiter)?

1. [limiter](https://www.npmjs.com/package/limiter) does not offer any queue to order the requests. This means an unlucky task could be waiting forever, because other active and lucky tasks just keep consuming all the tokens. Our limiter comes bundled with a prioritized FIFO queue, so you can customize the priority of each task, and tasks with the same priority are completed in FIFO order.

2. [bottleneck](https://www.npmjs.com/package/limiter) reservoirs do not support a rolling window. If you add 10 jobs just 1ms before the reservoir refresh is triggered, the first 5 jobs will run immediately, then 1ms later it will refresh the reservoir value and that will make the last 5 jobs also run right away, so you end up with 10 jobs running in parallel. Our limiter comes bundled with `RollingWindowTokenBucket` that keeps a history of past jobs to ensure you only launch desired number of jobs in the last `X` seconds no matter what.

## Quick Start

### Step 1 - Token Bucket

Create a token bucket. It holds tokens that represent a numeric cost of launching jobs. For example, you can create a bucket with 10 tokens. You can consume 1 token to launch a job with a cost of 1. Other jobs might consume more/less tokens, whatever makes more sense for your application.

```ts
import {
    RollingWindowTokenBucket,
    TokenBucket
} from '@mangosteen/rate-limiter';

// This token bucket does not care about history,
// so once a job consumes tokens from the bucket, it
// no longer has any effect on the bucket.
const basicTokenBucket = new TokenBucket({
    initialTokens: 10,
    maxTokens: 20,
});

// This token bucket keeps a history of past jobs in the
// last `X` milliseconds, and you may limit how many jobs
// can be launched during the history window.
const windowTokenBucket = new RollingWindowTokenBucket({
    initialTokens: 10,
    maxTokens: 20,
    historyIntervalMs: 5000,
    maxHistoryTokens: 3,
});
```

### Step 2 - Token Restoration

Token bucket by itself is just that - a storage of tokens. As you burn through the initial tokens, you may want to start restoring some tokens back! This is what token restorers are for.

```ts
import {
    ContinuousTokenRestorer,
    PeriodicTokenRestorer
} from '@mangosteen/rate-limiter';

// Periodic token restorers restore tokens ... periodically!
// After each period elapses, the specified number of tokens
// is restored to the bucket.
// The timer begins when the restorer is added to the first
// bucket. You may add the same restorer instance to multiple
// buckets, at which point the buckets will have their tokens
// restored all at the same time. You may also create a new
// restorer for each bucket instead, if you prefer them having
// separate timers.
const periodicRestorer = new PeriodicTokenRestorer({
    rate: {
        amount: 3,
        intervalMs: 1000,
    },
});
bucket.addTokenRestorer(periodicRestorer);

// Continuous token restorers restore tokens ... continuously!
// At any instant, we can compute how many (partial) tokens
// should be restored. Our token buckets can figure out the
// proper scheduling to make this work.
const continuousRestorer = new ContinuousTokenRestorer({
    rate: {
        amount: 3,
        intervalMs: 1000,
    },
});
bucket.addTokenRestorer(continuousRestorer);

// And last but not least, you can add arbitrary number of
// restorers to a single bucket!
bucket.addTokenRestorer(periodicRestorer1);
bucket.addTokenRestorer(periodicRestorer2);
bucket.addTokenRestorer(periodicRestorer3);
bucket.addTokenRestorer(continuousRestorer1);
bucket.addTokenRestorer(continuousRestorer2);
```

### Step 3.a - Using buckets directly

You can use buckets directly, if you do not care about job ordering, prioritization, or staggering.

```ts
const tokenCount = 3.7;

// Use `consumeTokens` to synchronously attempt to consume tokens.
// If it returns `true`, then tokens were consumed and you may
// continue your job.
// If it returns `false`, then there weren't enough tokens
// and you should wait for the tokens to be restored.
const tokensConsumed: boolean = bucket.consumeTokens(tokenCount);

// Use `onceTokensAvailable` to wait for the specified number of
// tokens to be available in the bucket. The return `promise` will
// resolve when there are tokens available. To cancel waiting,
// call the `cancel` callback and it will reject the promise
// with a `CanceledError`.
// 
// NOTE: once some tokens are restored to the bucket, all jobs
// waiting for tokens <= tokens_in_bucket will have their `promise`
// resolved, so all these jobs will then likely try to `consumeTokens`
// at the same time.
const { promise, cancel } = bucket.onceTokensAvailable(tokenCount);
await promise;

// Use `consumeTokensAsync` to combine `consumeTokens` and
// `onceTokensAvailable` to a single call. The return `promise`
// will resolve once the specified number of tokens have been
// successfully consumed. Use `cancel` to prematurely reject the
// `promise`.

const { promise, cancel } = bucket.consumeTokensAsync(tokenCount);
await promise;
```

### Step 3.b - Using rate limiter

Using buckets directly has the disadvantage of multiple jobs trying to consume tokens at the same time, with undefined outcome.

If you are spawning lots of jobs constantly, some jobs might get unlucky and never consume any tokens, effectively becoming stuck. This is the same issue that [limiter package](https://www.npmjs.com/package/limiter) has.

For that reason, we have created `PrioritizedFifoRateLimiter`!

```ts
import { PrioritizedFifoRateLimiter } from '@mangosteen/rate-limiter';

// `PrioritizedFifoRateLimiter` gives you the ability to specify
// priority for each job. A higher priority job will always execute
// before any lower priority jobs.
//
// Jobs with the same priority will be launched from a FIFO queue.
// 
// You can also specify stagger, which makes sure that jobs will
// never be launched faster than the specified interval. This allows
// you to avoid having lots of jobs launch all at the same time.
const limiter = new PrioritizedFifoRateLimiter({
    tokenBucket: bucket,

    // Optional:
    minStaggerTime: 250,
});

const tokenCount = 5.9;
const priority = 33.33;
const { promise, cancel } = limiter.consumeTokensAsync(tokenCount, priority);
await promise;
```

## Using custom high-precision timer

```ts
import {
    IntervalScheduler,
    TimeoutScheduler,
    TokenBucket,
    RollingWindowTokenBucket,
    PeriodicTokenRestorer
} from '@mangosteen/rate-limiter';
import NanoTimer from 'nanotimer';

// 1) Create a scheduler factory instance

const scheduler: TimeoutScheduler<NanoTimer> & IntervalScheduler<NanoTimer> = {
    setTimeout: (callback, ms) => {
        const timer = new NanoTimer();
        timer.setTimeout(callback, [], `${ms}m`);
        return timer;
    },
    clearTimeout: timer => {
        timer.clearTimeout();
    },
    setInterval: (callback, ms) => {
        const timer = new NanoTimer();
        timer.setInterval(callback, [], `${ms}m`);
        return timer;
    },
    clearInterval: timer => {
        timer.clearInterval();
    },
};

// 2) Pass `scheduler` to any (or all if you want!) class that accepts it:

const bucket1 = new TokenBucket({
    initialTokens: 0,
    scheduler,
});

const bucket2 = new RollingWindowTokenBucket({
    initialTokens: 0,
    historyIntervalMs: 1000,
    maxHistoryTokens: 10,
    scheduler,
});

const periodicRestorer = new PeriodicTokenRestorer({
    rate: {
        amount: 1,
        intervalMs: 1000,
    },
    scheduler,
});

const limiter = new PrioritizedFifoRateLimiter({
    tokenBucket: bucket2,
    scheduler,
});
```