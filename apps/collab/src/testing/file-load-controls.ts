import type { Client } from 'pg';
import { Leadership } from '../service/leadership.ts';
import { Revocations } from '../service/revocations.ts';

let stage = 'fixture';
export const setFileLoadStage = (value: string) => {
  stage = value;
};
/** Test-process observation only: no sampler, extra query, deadline or failure-policy change. */
export function traceFileLoadControls() {
  const report = (
    control: string,
    kind: string,
    error?: Error & { code?: string },
    elapsedMs?: number,
  ) => {
    console.error(
      JSON.stringify({
        diagnostic: kind,
        control,
        stage,
        name: error?.name,
        code: error?.code,
        message: error?.message,
        elapsedMs,
      }),
    );
  };
  const trace = (label: string, control: Client) => {
    control.on('error', (error) => report(label, 'control-error', error));
    control.on('end', () => report(label, 'control-ended'));
    const query = control.query;
    control.query = function (this: Client, ...args: unknown[]) {
      const started = performance.now();
      return (Reflect.apply(query, this, args) as Promise<unknown>).then(
        (r) => {
          const elapsed = performance.now() - started;
          if (elapsed >= 500) report(label, 'slow-control-query', undefined, elapsed);
          return r;
        },
        (error: Error) => {
          report(label, 'control-query-failed', error, performance.now() - started);
          throw error;
        },
      );
    } as typeof control.query;
  };
  const leaderStart = Leadership.prototype.start;
  Leadership.prototype.start = async function () {
    trace('leadership', (this as unknown as { control: Client }).control);
    return leaderStart.call(this);
  };
  const revokeStart = Revocations.prototype.start;
  Revocations.prototype.start = async function () {
    const probe = this as unknown as { control: Client; recheck: () => Promise<void> };
    trace('revocations', probe.control);
    const recheck = probe.recheck;
    probe.recheck = async () => {
      try {
        await recheck();
      } catch (error) {
        report('revocations', 'access-recheck-failed', error as Error);
        throw error;
      }
    };
    return revokeStart.call(this);
  };
}
