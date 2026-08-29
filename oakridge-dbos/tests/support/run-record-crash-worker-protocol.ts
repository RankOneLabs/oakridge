/**
 * Constants shared between `run-record-crash-worker.ts` (a standalone script,
 * always invoked with `bun run`, never imported) and the tests that spawn it.
 * Kept in their own module with no side effects, so the test file can import
 * them without triggering the worker script's top-level `DBOS.launch()`.
 */
export const START_OR_ATTACH_CALLED_MARKER = "CRASH_WORKER_START_OR_ATTACH_CALLED";
export const READY_MARKER = "CRASH_WORKER_READY";
