/**
 * The production `RunSnapshot` loader — the one read `derive` is evaluated over.
 *
 * Run inside `PostgresRunRecordWriter.decide`'s transaction. The run-row lock
 * serialises whole-run decisions, and owner version checks protect each stage
 * or cohort a decision writes.
 *
 * A stage's dependency edges are read off `stage_instance.stage_contract`, where
 * `initialize_run` wrote them from the compiled graph. They are stage-instance
 * ids, not stage keys: core has no business resolving a definition's names at
 * decision time (spec §1), and the ids are what `derive` closes over.
 */
import type { CohortSnapshot, RunDecisionSnapshot, RunSnapshot, StageSnapshot } from "../decision/snapshot";
import { err, ok, type ArtifactId, type CohortId, type JsonValue, type Result, type RunRecordVersion, type StageInstanceId, type WorkflowRunId } from "../domain/primitives";
import type { BlockedReason, CoreStatus, NextActor } from "../domain/records";
import type { SqlExecutor } from "./sql-executor";
import { artifactRefFromRevision, type ImplementationCohortInputs, type ImplementationCohortRecord,
  BuildWorkerRecord, AssessmentWorkerRecord, BuildResultArtifact, PrSummaryArtifact,
  AssessmentArtifact, AcceptedBuild, BuildWorkInput, AssessmentWorkInput,
  BuildResponse, AssessmentResponse, BuildInterruptedRecord, AssessmentInterruptedRecord,
  WorkerState, CohortState, ArtifactState, SessionState } from "../domain/dev-flow-v15";
import type { ExecutionId, SessionId } from "../domain/primitives";

/** The key `initialize_run` writes a stage's decision edges under. */
export const STAGE_CONTRACT_DEPENDENCY_KEY = "dependency_stage_instance_ids";

interface RunSnapshotRow {
  readonly id: string;
  readonly status: CoreStatus;
  readonly record_version: string;
  readonly outcome: JsonValue | null;
}

interface StageSnapshotRow {
  readonly id: string;
  readonly status: CoreStatus;
  readonly blocked_reason: BlockedReason | null;
  readonly next_actor: NextActor | null;
  readonly durable_version: string;
  readonly outcome: JsonValue | null;
  readonly dependency_stage_instance_ids: readonly string[];
  readonly accepted_artifact_ids: readonly string[];
}

interface CohortSnapshotRow {
  readonly id: string;
  readonly stage_instance_id: string;
  readonly status: CoreStatus;
  readonly blocked_reason: BlockedReason | null;
  readonly next_actor: NextActor | null;
  readonly durable_version: string;
  readonly outcome: JsonValue | null;
  readonly accepted_artifact_ids: readonly string[];
}

/**
 * Lock stages, cohorts, then the run, matching event ingress and cancellation.
 * Stage locks prevent new rosters from appearing outside this snapshot.
 */
export const loadRunSnapshot = async (tx: SqlExecutor, run_id: WorkflowRunId): Promise<Result<RunSnapshot, { readonly kind: "run_not_found"; readonly run_id: WorkflowRunId }>> => {
  // The stage lock also excludes roster inserts that a cohort-only lock misses.
  await tx.query(
    `SELECT id FROM oakridge.stage_instance WHERE run_id=$1 ORDER BY stage_key FOR UPDATE`, [run_id]);
  await tx.query(
    `SELECT cohort.id FROM oakridge.cohort cohort
     JOIN oakridge.stage_instance stage ON stage.id=cohort.stage_instance_id
     WHERE cohort.run_id=$1 ORDER BY stage.stage_key,cohort.cohort_key FOR UPDATE OF cohort`, [run_id]);
  const runs = await tx.query<RunSnapshotRow>(
    "SELECT id::text,status,record_version::text,outcome FROM oakridge.workflow_run WHERE id=$1 FOR UPDATE", [run_id]);
  const runRow = runs[0];
  if (!runRow) return err({ kind: "run_not_found", run_id });
  const run: RunDecisionSnapshot = {
    id: runRow.id as WorkflowRunId, status: runRow.status,
    record_version: Number(runRow.record_version) as RunRecordVersion, outcome: runRow.outcome,
  };

  const stageRows = await tx.query<StageSnapshotRow>(
    `SELECT stage.id::text,stage.status,stage.blocked_reason,stage.next_actor,stage.durable_version::text,stage.outcome,
            COALESCE(ARRAY(SELECT jsonb_array_elements_text(
              CASE WHEN jsonb_typeof(stage.stage_contract->'${STAGE_CONTRACT_DEPENDENCY_KEY}')='array'
                   THEN stage.stage_contract->'${STAGE_CONTRACT_DEPENDENCY_KEY}' ELSE '[]'::jsonb END)),
              ARRAY[]::text[]) AS dependency_stage_instance_ids,
            COALESCE(ARRAY(SELECT acceptance.artifact_id::text FROM oakridge.artifact_acceptance acceptance
              JOIN oakridge.artifact_owner owner ON owner.artifact_id=acceptance.artifact_id
              WHERE acceptance.receiving_stage_instance_id=stage.id AND owner.cohort_id IS NULL
              ORDER BY acceptance.artifact_id),ARRAY[]::text[]) AS accepted_artifact_ids
     FROM oakridge.stage_instance stage WHERE stage.run_id=$1 ORDER BY stage.id`, [run_id]);

  const cohortRows = await tx.query<CohortSnapshotRow>(
    `SELECT cohort.id::text,cohort.stage_instance_id::text,cohort.status,cohort.blocked_reason,cohort.next_actor,
            cohort.durable_version::text,cohort.outcome,
            COALESCE(ARRAY(SELECT acceptance.artifact_id::text FROM oakridge.artifact_acceptance acceptance
              JOIN oakridge.artifact_owner owner ON owner.artifact_id=acceptance.artifact_id
              WHERE owner.cohort_id=cohort.id ORDER BY acceptance.artifact_id),ARRAY[]::text[]) AS accepted_artifact_ids
     FROM oakridge.cohort cohort WHERE cohort.run_id=$1 ORDER BY cohort.id`, [run_id]);

  const cohortsByStage = new Map<string, CohortSnapshot[]>();
  for (const row of cohortRows) {
    const snapshot: CohortSnapshot = {
      id: row.id as CohortId, status: row.status, blocked_reason: row.blocked_reason, next_actor: row.next_actor,
      durable_version: Number(row.durable_version),
      accepted_artifact_ids: row.accepted_artifact_ids as readonly ArtifactId[], outcome: row.outcome,
    };
    const existing = cohortsByStage.get(row.stage_instance_id);
    if (existing) existing.push(snapshot); else cohortsByStage.set(row.stage_instance_id, [snapshot]);
  }

  const stages: StageSnapshot[] = stageRows.map((row) => ({
    id: row.id as StageInstanceId, status: row.status, blocked_reason: row.blocked_reason, next_actor: row.next_actor,
    durable_version: Number(row.durable_version),
    dependency_stage_instance_ids: row.dependency_stage_instance_ids as readonly StageInstanceId[],
    accepted_artifact_ids: row.accepted_artifact_ids as readonly ArtifactId[],
    cohorts: cohortsByStage.get(row.id) ?? [],
    outcome: row.outcome,
  }));

  return ok({ run, stages });
};

interface V15CohortRow {
  readonly id: string;
  readonly cohort_key: string;
  readonly durable_version: string;
  readonly state: CohortState;
  readonly depends_on: readonly string[];
  readonly frozen_inputs: ImplementationCohortInputs;
  readonly accepted_build: AcceptedBuild | null;
}
interface V15WorkerRow {
  readonly worker: "build" | "assessment";
  readonly state: WorkerState;
  readonly active_execution_id: string | null;
  readonly work: BuildWorkInput | AssessmentWorkInput | null;
  readonly response: BuildResponse | AssessmentResponse | null;
  readonly interrupted: BuildInterruptedRecord | AssessmentInterruptedRecord | null;
}
interface V15OutputRow {
  readonly worker: "build" | "assessment";
  readonly output_name: string;
  readonly chain_id: string;
  readonly revision: number;
  readonly artifact_type: string;
  readonly acceptance_state: ArtifactState;
  readonly body: JsonValue;
  readonly execution_id: string;
  readonly session_id: string | null;
}
interface V15SessionRow {
  readonly worker: "build" | "assessment";
  readonly id: string;
  readonly execution_id: string;
  readonly action_point: string;
  readonly status: string;
}

const sessionState = (status: string): SessionState => {
  if (status === "active" || status === "pending") return "running";
  if (status === "cancelled") return "cancelled";
  if (status === "failed") return "interrupted";
  return "finished";
};

/** One authoritative implementation snapshot, assembled from per-worker rows. */
export const loadImplementationCohortSnapshot = async (tx: SqlExecutor,
  cohort_id: CohortId): Promise<Result<ImplementationCohortRecord, { readonly kind: "cohort_not_found" | "invalid_snapshot";
    readonly cohort_id: CohortId; readonly detail: string }>> => {
  const cohorts = await tx.query<V15CohortRow>(
    `SELECT id::text,cohort_key,durable_version::text,state,depends_on,frozen_inputs,accepted_build
     FROM oakridge.cohort WHERE id=$1`, [cohort_id]);
  const row = cohorts[0];
  if (!row) return err({ kind: "cohort_not_found", cohort_id, detail: "cohort was not found" });
  if (!row.frozen_inputs || typeof row.frozen_inputs !== "object" || !("brief" in row.frozen_inputs)
    || !("repository" in row.frozen_inputs))
    return err({ kind: "invalid_snapshot", cohort_id, detail: "frozen implementation inputs are missing" });
  const workers = await tx.query<V15WorkerRow>(
    `SELECT worker,state,active_execution_id,work,response,interrupted
     FROM oakridge.cohort_worker WHERE cohort_id=$1 AND worker IN ('build','assessment')`, [cohort_id]);
  const buildRow = workers.find((worker) => worker.worker === "build");
  const assessmentRow = workers.find((worker) => worker.worker === "assessment");
  if (!buildRow || !assessmentRow)
    return err({ kind: "invalid_snapshot", cohort_id, detail: "implementation worker rows are missing" });
  const outputs = await tx.query<V15OutputRow>(
    `SELECT output.worker,output.output_name,artifact.chain_id::text,artifact.revision,
      artifact.artifact_type,output.acceptance_state,artifact.body,intent.id AS execution_id,
      provenance.session_id::text
     FROM oakridge.worker_output output
     JOIN oakridge.artifact artifact ON artifact.id=output.artifact_id
     JOIN oakridge.artifact_provenance provenance ON provenance.artifact_id=artifact.id
     JOIN oakridge.execution_intent intent ON intent.attempt_id=provenance.attempt_id
     WHERE output.cohort_id=$1 ORDER BY output.worker,output.output_name`, [cohort_id]);
  const sessions = await tx.query<V15SessionRow>(
    `SELECT intent.worker,session.id::text,intent.id AS execution_id,intent.action_point,session.status::text
     FROM oakridge.execution_intent intent JOIN oakridge.session session ON session.id=intent.session_id
     WHERE intent.cohort_id=$1 ORDER BY session.created_at`, [cohort_id]);
  const output = (worker: "build" | "assessment", name: string) =>
    outputs.find((candidate) => candidate.worker === worker && candidate.output_name === name);
  const materialize = (stored: V15OutputRow | undefined) => stored ? {
    ...artifactRefFromRevision({ chain_id: stored.chain_id as ArtifactId, revision: stored.revision }),
    state: stored.acceptance_state,
    body: stored.body, provenance: { execution_id: stored.execution_id as ExecutionId,
      session_id: stored.session_id as SessionId | null },
  } : null;
  const build: BuildWorkerRecord = {
    state: buildRow.state, active_execution_id: buildRow.active_execution_id as ExecutionId | null,
    work: buildRow.work as BuildWorkInput | null, response: buildRow.response as BuildResponse | null,
    interrupted: buildRow.interrupted as BuildInterruptedRecord | null,
    outputs: { build_result: materialize(output("build", "build_result")) as BuildResultArtifact | null,
      pr_summary: materialize(output("build", "pr_summary")) as PrSummaryArtifact | null },
    sessions: sessions.filter((session) => session.worker === "build").map((session) => ({
      id: session.id as SessionId, execution_id: session.execution_id as ExecutionId,
      action_point: session.action_point as "initial" | "revise" | "retry" | "replace_pr",
      state: sessionState(session.status),
    })),
  };
  const assessment: AssessmentWorkerRecord = {
    state: assessmentRow.state, active_execution_id: assessmentRow.active_execution_id as ExecutionId | null,
    work: assessmentRow.work as AssessmentWorkInput | null,
    response: assessmentRow.response as AssessmentResponse | null,
    interrupted: assessmentRow.interrupted as AssessmentInterruptedRecord | null,
    outputs: { assessment: materialize(output("assessment", "assessment")) as AssessmentArtifact | null },
    sessions: sessions.filter((session) => session.worker === "assessment").map((session) => ({
      id: session.id as SessionId, execution_id: session.execution_id as ExecutionId,
      action_point: session.action_point as "initial" | "discuss" | "retry",
      state: sessionState(session.status),
    })),
  };
  return ok({ id: row.id as CohortId, key: row.cohort_key as ImplementationCohortRecord["key"],
    version: Number(row.durable_version), state: row.state, depends_on: row.depends_on as readonly CohortId[],
    inputs: row.frozen_inputs, build, assessment, accepted_build: row.accepted_build });
};
