import type { WorkflowRunRepository } from "../storage/repositories";
import type { Result, RootWorkflowId, WorkflowRunId } from "../domain/primitives";
import { evaluateCohort, type CohortEvaluationInput } from "../decision/stage-machine";
import type { CohortDecisionError, OperatorRequestEnvelope, SelectedDecision } from "../domain/dev-flow-v15";
import type { CommitSelectedCohortError, CommittedSelectedCohort } from "../storage/postgres-run-record";

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
  readonly load: () => Promise<Omit<CohortEvaluationInput, "request">>;
  readonly commit: (decision: Extract<SelectedDecision, { readonly kind: "apply" }>,
    request: OperatorRequestEnvelope | null) => Promise<Result<CommittedSelectedCohort, CommitSelectedCohortError>>;
  readonly dispatch: (execution_ids: CommittedSelectedCohort["execution_ids"]) => Promise<void>;
}

export type CohortProgressionError = CohortDecisionError | CommitSelectedCohortError
  | { readonly kind: "progression_limit"; readonly detail: string };

/** A request is offered until one commit consumes it; automatic decisions then run to quiescence. */
export const advanceCohortUntilWait = async (port: CohortProgressionPort,
  request: OperatorRequestEnvelope | null): Promise<Result<{ readonly commits: number; readonly reason: string }, CohortProgressionError>> => {
  let pending_request = request;
  let commits = 0;
  for (let index = 0; index < 128; index++) {
    const snapshot = await port.load();
    const selected = evaluateCohort({ ...snapshot, request: pending_request?.request ?? null });
    if (!selected.ok) return selected;
    if (selected.value.kind === "wait") return { ok: true, value: { commits, reason: selected.value.reason } };
    const committed = await port.commit(selected.value, pending_request);
    if (!committed.ok) {
      if (committed.error.kind === "version_conflict") continue;
      return committed;
    }
    commits++;
    pending_request = null;
    await port.dispatch(committed.value.execution_ids);
  }
  return { ok: false, error: { kind: "progression_limit", detail: "cohort did not reach a wait in 128 commits" } };
};
