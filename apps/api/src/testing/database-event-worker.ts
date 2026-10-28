import { processDatabaseRowEvent } from '@memoria/db';

/** Production aggregation function with the worker's 250ms / 20 jobs cadence, isolated schema. */
export function databaseEventWorker(pool: Parameters<typeof processDatabaseRowEvent>[0]) {
  let stopping = false,
    pending: Promise<void> | undefined,
    failure: unknown,
    processed = 0;
  const timer = setInterval(() => {
    if (stopping || pending || failure) return;
    pending = (async () => {
      for (let i = 0; i < 20 && !stopping; i++) {
        if (!(await processDatabaseRowEvent(pool))) break;
        processed++;
      }
    })()
      .catch((e: unknown) => {
        failure = e;
      })
      .finally(() => {
        pending = undefined;
      });
  }, 250);
  return {
    count: () => processed,
    check() {
      if (failure) throw failure;
    },
    async close() {
      stopping = true;
      clearInterval(timer);
      await pending;
    },
  };
}
