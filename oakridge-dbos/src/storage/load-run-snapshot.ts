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
