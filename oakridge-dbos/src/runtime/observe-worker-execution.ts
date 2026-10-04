import type { ExecutorAdapter } from "../domain/execution";
import { err, ok, type CohortId, type ExecutionId, type Result, type SessionId } from "../domain/primitives";
import type { StageEventApplier } from "../storage/apply-stage-event";
import { writeSessionStatus } from "../storage/postgres-run-record";
import type { TransactionalSqlExecutor } from "../storage/sql-executor";

export interface WorkerObservationDependencies {
  readonly sql: TransactionalSqlExecutor;
  readonly adapter: ExecutorAdapter | undefined;
  readonly stage_events: StageEventApplier;
  readonly now: () => string;
}
interface ObservedWorkerRow {
  readonly worker: string;
  readonly status: string;
  readonly cohort_id: CohortId;
  readonly session_id: SessionId | null;
  readonly kbbl_session_id: string | null;
  readonly ended_at: string | null;
}
export interface WorkerObservationError { readonly operation: "observe_worker_execution"; readonly execution_id: ExecutionId; readonly detail: string }
export type WorkerObservation = { readonly kind: "waiting" } | { readonly kind: "terminal" };

/** Session health is observed separately from artifact readiness and acceptance. */
export const observeWorkerExecution = async (dependencies: WorkerObservationDependencies, execution_id: ExecutionId):
  Promise<Result<WorkerObservation, WorkerObservationError>> => {
  try {
    const rows = await dependencies.sql.query<ObservedWorkerRow>(
      `SELECT intent.worker,intent.status,intent.cohort_id::text,intent.session_id::text,
        session.kbbl_session_id,session.ended_at::text FROM oakridge.execution_intent intent
       LEFT JOIN oakridge.session session ON session.id=intent.session_id WHERE intent.id=$1`, [execution_id]);
    const row = rows[0];
    if (!row || row.worker === "provision" || ["cancelled", "interrupted"].includes(row.status)) return ok({ kind: "terminal" });
    if (!row.session_id || !row.kbbl_session_id) return ok({ kind: "waiting" });
    if (row.ended_at) {
      const advanced = await dependencies.stage_events.advance_local(row.cohort_id);
      return advanced.ok ? ok({ kind: "terminal" }) : err({ operation: "observe_worker_execution", execution_id,
        detail: "detail" in advanced.error ? advanced.error.detail : advanced.error.kind });
    }
    const adapter = dependencies.adapter;
    if (!adapter) return err({ operation: "observe_worker_execution", execution_id, detail: "delegated session adapter is missing" });
    const observation = await adapter.observe_terminal(execution_id, { kind: "kbbl_session", session_id: row.kbbl_session_id });
    if (observation.kind === "executor_unavailable") return err({ operation: "observe_worker_execution", execution_id, detail: observation.detail });
    if (observation.kind !== "terminal") return ok({ kind: "waiting" });
    // Live artifacts can already have moved the worker to review while the agent was running.
    await dependencies.stage_events.advance_local(row.cohort_id);
    const outcome = observation.observation;
    const written = await dependencies.sql.transaction((tx) => writeSessionStatus(tx, { session_id: row.session_id!,
      status: outcome.kind === "succeeded" ? "complete" : outcome.kind === "cancelled" ? "cancelled" : "failed", at: dependencies.now() }));
    if (!written.ok) return err({ operation: "observe_worker_execution", execution_id, detail: written.error.detail });
    const advanced = await dependencies.stage_events.advance_local(row.cohort_id);
    return advanced.ok ? ok({ kind: "terminal" }) : err({ operation: "observe_worker_execution", execution_id,
      detail: "detail" in advanced.error ? advanced.error.detail : advanced.error.kind });
  } catch (cause) {
    return err({ operation: "observe_worker_execution", execution_id, detail: String(cause) });
  }
};
