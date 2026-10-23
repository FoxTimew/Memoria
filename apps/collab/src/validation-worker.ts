import { parentPort } from 'node:worker_threads';
import { validateCandidate } from './codec.ts';

parentPort!.on('message', ({ base, update }: { base: Uint8Array; update: Uint8Array }) => {
  const started = performance.now();
  try {
    const result = validateCandidate(base, update);
    parentPort!.postMessage({ ...result, validationMs: performance.now() - started });
  } catch (error) {
    parentPort!.postMessage({
      error: error instanceof Error ? error.message : 'Validation rejected',
    });
  }
});
