import { DBOS } from "@dbos-inc/dbos-sdk";

export const RUN_SWEEP_INTERVAL_MS = 60_000;

export interface RunSweep {
  /** Stops future ticks and waits for a sweep in flight, so nothing restarts a workflow after shutdown parks it. */
  stop(): Promise<void>;
}

/** Recover runs a lost wake left without a workflow; a sweep still in flight skips the next tick. */
export function startRunSweep(sweep: () => Promise<void>, interval_ms = RUN_SWEEP_INTERVAL_MS): RunSweep {
  let in_flight: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (in_flight) return;
    in_flight = sweep()
      .catch((error: unknown) => DBOS.logger.warn(`run sweep failed: ${String(error)}`))
      .finally(() => { in_flight = null; });
  }, interval_ms);
  return { async stop() { clearInterval(timer); await in_flight; } };
}
