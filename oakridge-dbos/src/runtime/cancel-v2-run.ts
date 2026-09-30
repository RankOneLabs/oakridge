import type { ExecutorAdapter } from "../domain/execution";
import type { ExecutionId, WorkflowRunId } from "../domain/primitives";
import type { CancelRunRecordResult } from "../domain/run-record";
import type { RunRecordRepository } from "../storage/repositories";

export interface CancelV2RunDependencies {
  readonly records: Pick<RunRecordRepository, "cancel_run" | "observe_session">;
  find_executor(executor_type: string): ExecutorAdapter | undefined;
  now(): string;
  send_run_wake?: (run_id: WorkflowRunId, idempotency_key: string) => Promise<void>;
}

/**
 * Domain cancellation commits first; session fencing is independent diagnostic
 * cleanup.
 *
 * `already_terminal` is a completed sweep, not a reason to stop: `cancel_run` is
 * re-entrant precisely because a crash can leave a cancelled run with active
 * owners and unfenced sessions, and returning early on it meant the retry that
 * finished the owners never reached the sessions.
 */
export const cancelV2Run = async (
  run_id: WorkflowRunId,
  dependencies: CancelV2RunDependencies,
  reason: string | null = null,
): Promise<CancelRunRecordResult> => {
  const cancelledAt = dependencies.now();
  const result = await dependencies.records.cancel_run({ run_id, actor: "operator", reason, cancelled_at: cancelledAt });
  // Neither of these cancelled anything, so there is nothing to fence and no
  // status change to wake the run for. `run_busy` is the retryable one: the run
  // is still live and still whatever it was.
  if (result.kind === "run_not_found" || result.kind === "run_busy") return result;
  await Promise.all(result.sessions_to_fence.map(async (session) => {
    const adapter = dependencies.find_executor(session.executor_type);
    const observedAt = dependencies.now();
    if (!adapter) {
      await dependencies.records.observe_session({ session_id: session.session_id,
        health: { kind: "unresponsive", detail: `executor '${session.executor_type}' is unavailable for cancellation`, observed_at: observedAt },
        observed_at: observedAt });
      return;
    }
    try {
      await adapter.cancel_or_fence(session.attempt_id as unknown as ExecutionId, session.external_reference);
      await dependencies.records.observe_session({ session_id: session.session_id,
        health: { kind: "ended_cancelled", detail: reason, observed_at: observedAt }, observed_at: observedAt });
    } catch (cause) {
      await dependencies.records.observe_session({ session_id: session.session_id,
        health: { kind: "unresponsive", detail: cause instanceof Error ? cause.message : String(cause), observed_at: observedAt },
        observed_at: observedAt });
    }
  }));
  const wakeKey = result.kind === "cancelled" ? `cancelled:${run_id}:${result.record_version}` : `cancelled:${run_id}:${result.status}`;
  await dependencies.send_run_wake?.(run_id, wakeKey).catch(() => undefined);
  return result;
};
