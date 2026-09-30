import type { WorkflowRunId } from "../../src/domain/primitives";
import type { StageOutcome } from "../../src/domain/workflow";
import type { SqlExecutor } from "../../src/storage/sql-executor";

export interface BuildCohortRow {
  readonly unit_id: string;
  readonly state: string;
}

export const buildUnitRows = (sql: SqlExecutor, run_id: WorkflowRunId): Promise<readonly BuildCohortRow[]> =>
  sql.query<BuildCohortRow>(`SELECT cohort.cohort_key AS unit_id, cohort.status::text AS state
    FROM oakridge.cohort cohort JOIN oakridge.stage_instance stage ON stage.id=cohort.stage_instance_id
    WHERE cohort.run_id=$1 AND stage.stage_key='build' ORDER BY cohort.cohort_key`, [run_id]);

export const countBuildOrdersInState = async (sql: SqlExecutor, run_id: WorkflowRunId, status: string): Promise<number> => {
  const rows = await sql.query<{ readonly count: string }>(`SELECT count(*)::text AS count FROM oakridge.attempt attempt
    JOIN oakridge.stage_instance stage ON stage.id=attempt.stage_instance_id
    WHERE attempt.run_id=$1 AND stage.stage_key='build' AND attempt.status::text=$2`, [run_id, status]);
  return Number(rows[0]?.count ?? 0);
};

export const transitionVersion = async (sql: SqlExecutor, run_id: WorkflowRunId, reason: string,
  stage_key: string, cohort_key: string): Promise<number> => {
  const rows = await sql.query<{ readonly version: string }>(`SELECT transition.resulting_owner_version::text AS version
    FROM oakridge.run_transition transition JOIN oakridge.cohort cohort ON cohort.id=transition.owner_cohort_id
    JOIN oakridge.stage_instance stage ON stage.id=cohort.stage_instance_id
    WHERE transition.run_id=$1 AND transition.launch_reason=$2 AND stage.stage_key=$3 AND cohort.cohort_key=$4
    ORDER BY transition.resulting_owner_version LIMIT 1`, [run_id, reason, stage_key, cohort_key]);
  if (!rows[0]) throw new Error(`no '${reason}' transition for ${stage_key}/${cohort_key} on run ${run_id}`);
  return Number(rows[0].version);
};

export const transitionCountFor = async (sql: SqlExecutor, run_id: WorkflowRunId, reason: string,
  stage_key: string, cohort_key: string): Promise<number> => {
  const rows = await sql.query<{ readonly count: string }>(`SELECT count(*)::text AS count
    FROM oakridge.run_transition transition JOIN oakridge.cohort cohort ON cohort.id=transition.owner_cohort_id
    JOIN oakridge.stage_instance stage ON stage.id=cohort.stage_instance_id
    WHERE transition.run_id=$1 AND transition.launch_reason=$2 AND stage.stage_key=$3 AND cohort.cohort_key=$4`,
    [run_id, reason, stage_key, cohort_key]);
  return Number(rows[0]?.count ?? 0);
};

export const workflowRunState = async (sql: SqlExecutor, run_id: WorkflowRunId): Promise<string> => {
  const rows = await sql.query<{ readonly status: string }>("SELECT status::text FROM oakridge.workflow_run WHERE id=$1", [run_id]);
  if (!rows[0]) throw new Error(`workflow run '${run_id}' was not found`);
  return rows[0].status;
};

export const openBriefGateUnitIds = async (sql: SqlExecutor, run_id: WorkflowRunId): Promise<ReadonlySet<string>> => {
  const rows = await sql.query<{ readonly unit_id: string }>(`SELECT DISTINCT COALESCE(slot.collection_key, cohort.cohort_key) AS unit_id
    FROM oakridge.wait_gate wait JOIN oakridge.cohort cohort ON cohort.id=wait.cohort_id
    JOIN oakridge.stage_instance stage ON stage.id=wait.stage_instance_id
    LEFT JOIN oakridge.wait_gate_output_slot slot ON slot.wait_gate_id=wait.id
    WHERE wait.run_id=$1 AND stage.stage_key='brief_writer' AND wait.kind='gate' AND wait.status='open'`, [run_id]);
  return new Set(rows.map((row) => row.unit_id));
};

export const startedBuildUnitIds = async (sql: SqlExecutor, run_id: WorkflowRunId): Promise<readonly string[]> => {
  const rows = await sql.query<{ readonly unit_id: string }>(`SELECT DISTINCT cohort.cohort_key AS unit_id
    FROM oakridge.attempt attempt JOIN oakridge.cohort cohort ON cohort.id=attempt.cohort_id
    JOIN oakridge.stage_instance stage ON stage.id=attempt.stage_instance_id
    WHERE attempt.run_id=$1 AND stage.stage_key='build' AND attempt.status='active'`, [run_id]);
  return rows.map((row) => row.unit_id);
};

export const buildDependencies = async (sql: SqlExecutor, run_id: WorkflowRunId, cohort_key: string): Promise<readonly string[]> => {
  const rows = await sql.query<{ readonly depends_on: string[] | null }>(`SELECT array_agg(dependency.value) AS depends_on
    FROM oakridge.artifact artifact JOIN oakridge.artifact_acceptance acceptance ON acceptance.artifact_id=artifact.id
    JOIN oakridge.stage_instance stage ON stage.id=acceptance.receiving_stage_instance_id
    CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(artifact.body->'depends_on','[]'::jsonb)) dependency(value)
    WHERE acceptance.run_id=$1 AND stage.stage_key='brief_writer' AND acceptance.collection_key=$2`, [run_id, cohort_key]);
  return rows[0]?.depends_on ?? [];
};

export const runOutcome = async (sql: SqlExecutor, run_id: WorkflowRunId): Promise<StageOutcome | null> => {
  const rows = await sql.query<{ readonly outcome: StageOutcome | null }>("SELECT outcome FROM oakridge.workflow_run WHERE id=$1", [run_id]);
  return rows[0]?.outcome ?? null;
};

export const materializationFailedTransitions = (sql: SqlExecutor, run_id: WorkflowRunId): Promise<readonly { readonly detail: unknown }[]> =>
  sql.query<{ readonly detail: unknown }>(`SELECT effect_descriptor AS detail FROM oakridge.run_transition
    WHERE run_id=$1 AND effect_descriptor->>'kind'='materialization_failed'`, [run_id]);

export const closedGateWaitCount = async (sql: SqlExecutor, run_id: WorkflowRunId, stage_key: string): Promise<number> => {
  const rows = await sql.query<{ readonly count: string }>(`SELECT count(*)::text AS count FROM oakridge.wait_gate wait
    JOIN oakridge.stage_instance stage ON stage.id=wait.stage_instance_id
    WHERE wait.run_id=$1 AND stage.stage_key=$2 AND wait.kind='gate' AND wait.status='closed'`, [run_id, stage_key]);
  return Number(rows[0]?.count ?? 0);
};

export const buildStageRow = async (sql: SqlExecutor, run_id: WorkflowRunId): Promise<{ readonly state: string } | null> => {
  const rows = await sql.query<{ readonly state: string }>(`SELECT status::text AS state FROM oakridge.stage_instance
    WHERE run_id=$1 AND stage_key='build'`, [run_id]);
  return rows[0] ?? null;
};

export const attemptsAfterCancel = async (sql: SqlExecutor, run_id: WorkflowRunId): Promise<number> => {
  const rows = await sql.query<{ readonly count: string }>(`SELECT count(*)::text AS count FROM oakridge.attempt attempt
    WHERE attempt.run_id=$1 AND attempt.created_at >
      (SELECT min(created_at) FROM oakridge.run_transition WHERE run_id=$1 AND launch_reason='operator'
        AND effect_descriptor->>'kind'='none')`, [run_id]);
  return Number(rows[0]?.count ?? 0);
};
