import NanoTimer from 'nanotimer';
import { IntervalScheduler, TimeoutScheduler } from './models';
import { PrioritizedFifoRateLimiter } from './rate-limiter';
import { RollingWindowTokenBucket } from './rolling-window-token-bucket';
import { ContinuousTokenRestorer, PeriodicTokenRestorer } from './token-restorers';

// Custom high-precision scheduler
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

main().catch(error => {
    console.error(error);
    process.exit(1);
});

async function main(): Promise<void> {

    // const tokenBucket = new TokenBucket({
    //     initialTokens: 1,
    //     maxTokens: 1,
    //     scheduler,
    // });

    const tokenBucket = new RollingWindowTokenBucket({
        initialTokens: 3,
        maxTokens: 3,
        historyIntervalMs: 5000,
        maxHistoryTokens: 3,
        scheduler,
    });

    tokenBucket.addTokenRestorer(
        new ContinuousTokenRestorer(
            {
                amount: 1,
                intervalMs: 500,
            },
        ),
    );
    
    tokenBucket.addTokenRestorer(
        new PeriodicTokenRestorer(
            {
                amount: 10,
                intervalMs: 1000,
            },
            scheduler,
        ),
    );
    
    const limiter = new PrioritizedFifoRateLimiter({
        tokenBucket,
        minStaggerTime: 250,
        scheduler,
    });

    const parallelism = 50;

    for (let p = 0; p < parallelism; p++) {
        (async () => {
            for (let i = 0; i < 30; i++) {
                const { promise } = limiter.consumeTokensAsync(1, 1);
                await promise;
                // await tokenBucket.consumeTokensAsync(1);

                console.log(p, new Date().toISOString());
            }
        })();
    }
}

// async function testMemoryLeaks(): Promise<void> {
//     const parallelism = 3000;

//     const bucket = new RollingWindowTokenBucket({
//         initialTokens: parallelism,
//         maxTokens: parallelism,
//         historyIntervalMs: 1000,
//         maxHistoryTokens: parallelism,
//     });
    
//     bucket.addTokenRestorer(new ContinuousTokenRestorer({
//         amount: parallelism,
//         intervalMs: 1000,
//     }));
    
//     const limiter = new PrioritizedFifoRateLimiter({
//         tokenBucket: bucket,
//     });

//     setInterval(() => {
//         console.log();
//         console.log('-----');
//         console.log();

//         const used = process.memoryUsage();
//         for (let key in used) {
//             // @ts-ignore
//             console.log(`${key} ${Math.round(used[key] / 1024 / 1024 * 100) / 100} MB`);
//         }
//     }, 5000);

//     for (let p = 0; p < parallelism; p++) {
//         (async () => {
//             while (true) {
//                 const { promise } = limiter.consumeTokensAsync(1, 0);
//                 await promise;
//             }
//         })();
//     }
// }