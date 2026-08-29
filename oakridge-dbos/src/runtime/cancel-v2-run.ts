import type { ExecutorAdapter } from "../domain/execution";
import type { ExecutionId, WorkflowRunId } from "../domain/primitives";
import type { CancelRunRecordResult } from "../domain/run-record";
import type { RunRecordRepository } from "../storage/repositories";

export interface CancelV2RunDependencies {
  readonly records: Pick<RunRecordRepository, "cancel_run" | "observe_executor">;
  find_executor(executor_type: string): ExecutorAdapter | undefined;
  now(): string;
  send_run_wake?: (run_id: WorkflowRunId, idempotency_key: string) => Promise<void>;
}

/** Domain cancellation commits first; executor fencing is independent diagnostic cleanup. */
export const cancelV2Run = async (
  run_id: WorkflowRunId,
  dependencies: CancelV2RunDependencies,
  reason: string | null = null,
): Promise<CancelRunRecordResult> => {
  const cancelledAt = dependencies.now();
  const result = await dependencies.records.cancel_run({ run_id, actor: "operator", reason, cancelled_at: cancelledAt });
  if (result.kind !== "cancelled") return result;
  await Promise.all(result.work_orders_to_fence.map(async (work) => {
    const adapter = dependencies.find_executor(work.executor_type);
    if (!adapter) {
      await dependencies.records.observe_executor(work.work_order_id, { kind: "unresponsive", detail: `executor '${work.executor_type}' is unavailable for cancellation`, observed_at: dependencies.now() }, dependencies.now());
      return;
    }
    try {
      await adapter.cancel_or_fence(work.work_order_id as unknown as ExecutionId, work.external_reference);
      const observedAt = dependencies.now();
      await dependencies.records.observe_executor(work.work_order_id, { kind: "ended_cancelled", detail: reason, observed_at: observedAt }, observedAt);
    } catch (cause) {
      const observedAt = dependencies.now();
      await dependencies.records.observe_executor(work.work_order_id, { kind: "unresponsive", detail: cause instanceof Error ? cause.message : String(cause), observed_at: observedAt }, observedAt);
    }
  }));
  await dependencies.send_run_wake?.(run_id, `cancelled:${run_id}:${result.record_version}`).catch(() => undefined);
  return result;
};
