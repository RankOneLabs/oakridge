import type { WorkflowRunRepository } from "../storage/repositories";
import type { Result, RootWorkflowId, WorkflowRunId } from "../domain/primitives";
import { evaluateCohort, type CohortEvaluationInput } from "../decision/stage-machine";
import type { CohortDecisionError, OperatorRequestEnvelope } from "../domain/dev-flow-v15";
import type { CommitSelectedCohortError, CommittedSelectedCohort } from "../storage/postgres-run-record";
import { evaluateV15Cohort, type V15EvaluationInput, type V15SelectedDecision } from "../decision/stage-machine";
import type { V15OperatorRequestEnvelope } from "../domain/dev-flow-v15";

export interface RunStartRequest {
  readonly workflow_id: RootWorkflowId;
  readonly run_id: WorkflowRunId;
  readonly application_version?: string;
}

export interface RunStartError {
  readonly operation: "start_v2_run";
  readonly workflow_id: RootWorkflowId;
  readonly run_id: WorkflowRunId;
  readonly detail: string;
}

export interface RunLaunchDbosClient {
  start_v2_run(request: RunStartRequest): Promise<Result<void, RunStartError>>;
}

/**
 * The launch sweep. A launched run is durable the moment `create_run`
 * commits its row — no outbox table backs the launch any more — so what is
 * "pending" is discovered by reading `workflow_run` against
 * `dbos.workflow_status` (`list_unstarted_runs`) rather than claimed off a
 * queue. DBOS's own `enqueuePortable` is `ON CONFLICT (workflow_uuid) DO
 * NOTHING` (`node_modules/@dbos-inc/dbos-sdk/dist/src/system_database.js:682`),
 * so starting the same run twice from two callers of this sweep — or from
 * the sweep racing the HTTP launch path that also calls `start_v2_run` — is
 * always a no-op, and nothing here needs to coordinate that itself.
 *
 * A run whose start fails is left exactly as unstarted as it was, so a
 * failing DBOS must not stop the sweep from finishing its current page — but
 * it must end the sweep there: a failed run is still "unstarted", so the next
 * page would hand it straight back, and a hundred persistently failing runs
 * would spin this loop forever. The next timer tick (1 s) is the retry.
 */
export const dispatchRunLaunches = async (
  runs: Pick<WorkflowRunRepository, "list_unstarted_runs">,
  dbos: RunLaunchDbosClient,
  application_version: string | null,
): Promise<number> => {
  const PAGE_SIZE = 100;
  let started = 0;
  for (;;) {
    const page = await runs.list_unstarted_runs(PAGE_SIZE);
    let failed = 0;
    for (const run of page) {
      const result = await dbos.start_v2_run({ workflow_id: run.workflow_id, run_id: run.run_id,
        ...(application_version ? { application_version } : {}) });
      if (result.ok) started += 1;
      else {
        failed += 1;
        console.warn(`oakridge: run launch failed: ${result.error.operation}:workflow_id=${result.error.workflow_id}:run_id=${result.error.run_id}:${result.error.detail}`);
      }
    }
    if (page.length < PAGE_SIZE || failed > 0) return started;
  }
};

export interface CohortProgressionPort {
  readonly load: () => Promise<Omit<CohortEvaluationInput, "request"> | Omit<V15EvaluationInput, "request">>;
  readonly commit: (decision: Extract<V15SelectedDecision, { readonly kind: "apply" }>,
    request: V15OperatorRequestEnvelope | null) => Promise<Result<CommittedSelectedCohort, CommitSelectedCohortError>>;
  readonly dispatch: (execution_ids: CommittedSelectedCohort["execution_ids"]) => Promise<void>;
}

export type CohortProgressionError = CohortDecisionError | CommitSelectedCohortError
  | { readonly kind: "progression_limit"; readonly detail: string };

/** A request is offered until one commit consumes it; automatic decisions then run to quiescence. */
export const advanceCohortUntilWait = async (port: CohortProgressionPort,
  request: V15OperatorRequestEnvelope | null): Promise<Result<{ readonly commits: number; readonly reason: string }, CohortProgressionError>> => {
  let pending_request = request;
  let commits = 0;
  let has_version_conflict = false;
  for (let index = 0; index < 128; index++) {
    const snapshot = await port.load();
    const version = "context" in snapshot ? snapshot.context.cohort.version : snapshot.snapshot.version;
    if (pending_request && pending_request.expected_version !== version) {
      if (!has_version_conflict) return { ok: false, error: { kind: "version_conflict",
        expected_version: pending_request.expected_version, actual_version: version } };
      pending_request = { ...pending_request, expected_version: version };
    }
    const selected = "context" in snapshot
      ? evaluateV15Cohort({ ...snapshot, request: pending_request?.request ?? null })
      : evaluateCohort({ ...snapshot, request: pending_request?.request as OperatorRequestEnvelope["request"] ?? null });
    if (!selected.ok) return selected;
    if (selected.value.kind === "wait") return { ok: true, value: { commits, reason: selected.value.reason } };
    const committed = await port.commit(selected.value, pending_request);
    if (!committed.ok) {
      if (committed.error.kind === "version_conflict") { has_version_conflict = true; continue; }
      return committed;
    }
    commits++;
    pending_request = null;
    await port.dispatch(committed.value.execution_ids);
  }
  return { ok: false, error: { kind: "progression_limit", detail: "cohort did not reach a wait in 128 commits" } };
};

export interface CreatedWorkerSession {
  readonly execution_id: import("../domain/primitives").ExecutionId;
  readonly session_id: import("../domain/primitives").SessionId;
  readonly kbbl_session_id: string;
}
export interface WorkerSessionIO {
  /** Integration must attach on replay of this durable execution identity. */
  create_session(intent: import("../storage/postgres-run-record").ClaimedExecutionIntent):
    Promise<Result<CreatedWorkerSession, { readonly detail: string }>>;
  stop_session(session: CreatedWorkerSession): Promise<Result<void, { readonly detail: string }>>;
  now(): string;
}

/** IO mechanics only: claim, attach/create, link, and converge durable stops. */
export const dispatchCohortExecution = async (
  sql: import("../storage/sql-executor").TransactionalSqlExecutor,
  execution_id: import("../domain/primitives").ExecutionId,
  io: WorkerSessionIO,
): Promise<Result<void, { readonly kind: "dispatch_failed" | "stop_failed"; readonly detail: string }>> => {
  const { claimExecutionIntent, recordExecutionDispatch } = await import("../storage/postgres-run-record");
  const claimed = await claimExecutionIntent(sql, execution_id);
  if (!claimed.ok) return { ok: true, value: undefined };
  if (claimed.value.worker === "provision") return { ok: false, error: {
    kind: "dispatch_failed", detail: "provision operation cannot enter session dispatch" } };
  // Exceptions are normalized at the integration boundary, including uncertain
  // start outcomes. Recovery attaches using the same execution identity.
  let created: Awaited<ReturnType<WorkerSessionIO["create_session"]>>;
  try { created = await io.create_session(claimed.value); }
  catch (cause) { created = { ok: false, error: { detail: String(cause) } }; }
  await recordExecutionDispatch(sql, { execution_id,
    session_id: created.ok ? created.value.session_id : null,
    kbbl_session_id: created.ok ? created.value.kbbl_session_id : null,
    detail: created.ok ? null : created.error.detail, at: io.now() });
  if (!created.ok) return { ok: false, error: { kind: "dispatch_failed", detail: created.error.detail } };
  const stopped = await sql.query<{ readonly is_stopped: boolean }>(
    `SELECT intent.stop_requested_at IS NOT NULL OR intent.status <> 'dispatched'
       OR worker.active_execution_id IS DISTINCT FROM intent.id
       OR run.status <> 'active' OR stage.status <> 'active' AS is_stopped
     FROM oakridge.execution_intent intent
     JOIN oakridge.cohort_worker worker ON worker.cohort_id=intent.cohort_id AND worker.worker=intent.worker
     JOIN oakridge.cohort cohort ON cohort.id=intent.cohort_id
     JOIN oakridge.stage_instance stage ON stage.id=cohort.stage_instance_id
     JOIN oakridge.workflow_run run ON run.id=cohort.run_id WHERE intent.id=$1`, [execution_id]);
  if (stopped[0]?.is_stopped !== false) {
    let stop: Awaited<ReturnType<WorkerSessionIO["stop_session"]>>;
    try { stop = await io.stop_session(created.value); }
    catch (cause) { stop = { ok: false, error: { detail: String(cause) } }; }
    if (!stop.ok) return { ok: false, error: { kind: "stop_failed", detail: stop.error.detail } };
    const { writeSessionStatus } = await import("../storage/postgres-run-record");
    await sql.transaction(async (tx) => {
      const written = await writeSessionStatus(tx, { session_id: created.value.session_id, status: "cancelled", at: io.now() });
      if (!written.ok) throw new Error(written.error.detail);
    });
    await sql.query("UPDATE oakridge.execution_intent SET stop_completed_at=$2::timestamptz WHERE id=$1",
      [execution_id, io.now()]);
  }
  return { ok: true, value: undefined };
};

/** Stop requests survive the workflow that created the session. */
export const stopCohortExecution = async (
  sql: import("../storage/sql-executor").TransactionalSqlExecutor,
  execution_id: import("../domain/primitives").ExecutionId,
  io: WorkerSessionIO,
): Promise<Result<void, { readonly kind: "stop_failed"; readonly detail: string }>> => {
  const rows = await sql.query<{ readonly status: string; readonly session_id: import("../domain/primitives").SessionId | null;
    readonly kbbl_session_id: string | null; readonly stop_requested_at: string | null; readonly stop_completed_at: string | null }>(
    `SELECT intent.status,intent.session_id::text,session.kbbl_session_id,
      intent.stop_requested_at::text,intent.stop_completed_at::text FROM oakridge.execution_intent intent
     LEFT JOIN oakridge.session session ON session.id=intent.session_id WHERE intent.id=$1`, [execution_id]);
  const row = rows[0];
  if (!row || row.stop_requested_at === null || row.stop_completed_at !== null) return { ok: true, value: undefined };
  // An in-flight integration may still link a session; its dispatch boundary
  // rechecks this request and stops the returned handle before completing.
  if (row.status === "dispatching" && row.session_id === null) return { ok: true, value: undefined };
  if (row.session_id !== null && row.kbbl_session_id !== null) {
    let stopped: Awaited<ReturnType<WorkerSessionIO["stop_session"]>>;
    try { stopped = await io.stop_session({ execution_id, session_id: row.session_id, kbbl_session_id: row.kbbl_session_id }); }
    catch (cause) { stopped = { ok: false, error: { detail: String(cause) } }; }
    if (!stopped.ok) return { ok: false, error: { kind: "stop_failed", detail: stopped.error.detail } };
    const { writeSessionStatus } = await import("../storage/postgres-run-record");
    await sql.transaction(async (tx) => {
      const written = await writeSessionStatus(tx, { session_id: row.session_id!, status: "cancelled", at: io.now() });
      if (!written.ok) throw new Error(written.error.detail);
    });
  }
  await sql.query("UPDATE oakridge.execution_intent SET stop_completed_at=$2::timestamptz WHERE id=$1",
    [execution_id, io.now()]);
  return { ok: true, value: undefined };
};
