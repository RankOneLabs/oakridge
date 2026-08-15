import type { ArtifactId, StageInstanceId, UnitId, WorkflowRunId } from "../domain/primitives";
import type { ArtifactEmission, ArtifactRevision } from "../domain/artifacts";
import type { StageInstance, StageOutcome } from "../domain/workflow";
import type {
  ArtifactRepository,
  ArtifactRevisionRepository,
  ExecutionArtifactContextRepository,
  ExecutionArtifactContext,
  ExecutionProjectionRepository,
  InsertArtifact,
  StageInstanceRepository,
  StartStageInstance,
  WorkflowRunLaunch,
  WorkflowRunRepository,
  WorkflowRunRecord,
  WorkflowAttempt,
  WorkflowAttemptRepository,
  RerunTargetRepository,
  ResumeArtifactRepository,
  CancellationTargetRepository,
} from "./repositories";
import type { ExecutionId, JsonValue } from "../domain/primitives";
import type { ExecutionRequest, ExecutorTerminalObservation, ExternalExecutionReference } from "../domain/execution";
import type { SqlExecutor, TransactionalSqlExecutor } from "./sql-executor";
import type { CancellationExecutionTarget, UnitRerunTarget } from "../domain/rerun";

interface StageRow {
  readonly id: string;
  readonly run_id: string;
  readonly stage_key: string;
  readonly stage_type: string;
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly outcome: StageOutcome | null;
}

const decodeStage = (row: StageRow): StageInstance => ({
  id: row.id as StageInstance["id"],
  run_id: row.run_id as StageInstance["run_id"],
  stage_key: row.stage_key,
  stage_type: row.stage_type,
  lifecycle: row.ended_at && row.outcome
    ? { kind: "finished", started_at: row.started_at, ended_at: row.ended_at, outcome: row.outcome }
    : { kind: "started", started_at: row.started_at },
});

export class PostgresWorkflowRunRepository implements WorkflowRunRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async insert_launch(launch: WorkflowRunLaunch): Promise<void> {
    const rows = await this.sql.query<{ readonly id: string }>(
      `INSERT INTO oakridge.workflow_run
         (id, workflow_definition_id, context)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
       WHERE oakridge.workflow_run.workflow_definition_id = EXCLUDED.workflow_definition_id
         AND oakridge.workflow_run.context = EXCLUDED.context
       RETURNING id::text`,
      [launch.id, launch.workflow_definition_id, launch.context],
    );
    if (!rows[0]) throw new Error(`workflow run '${launch.id}' conflicts with an existing immutable launch`);
  }

  async find_by_id(id: WorkflowRunId): Promise<WorkflowRunRecord | null> {
    const rows = await this.sql.query<{ readonly id: string; readonly workflow_definition_id: string; readonly context: JsonValue; readonly archived: boolean }>(
      `SELECT id::text, workflow_definition_id::text, context, archived
       FROM oakridge.workflow_run WHERE id = $1`, [id]);
    const row = rows[0];
    return row ? { id: row.id as WorkflowRunId, workflow_definition_id: row.workflow_definition_id as WorkflowRunRecord["workflow_definition_id"], context: row.context, archived: row.archived } : null;
  }
}

export class PostgresWorkflowAttemptRepository implements WorkflowAttemptRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async insert(attempt: WorkflowAttempt): Promise<void> {
    await this.sql.query(
      `INSERT INTO oakridge.workflow_attempt
         (root_workflow_id, run_id, forked_from_root_workflow_id, created_at)
       VALUES ($1, $2, $3, $4::timestamptz)
       ON CONFLICT (root_workflow_id) DO NOTHING`,
      [attempt.root_workflow_id, attempt.run_id, attempt.forked_from_root_workflow_id, attempt.created_at],
    );
  }

  async find_by_root_workflow_id(root_workflow_id: string): Promise<WorkflowAttempt | null> {
    const rows = await this.sql.query<WorkflowAttempt>(
      `SELECT root_workflow_id, run_id::text AS run_id,
              forked_from_root_workflow_id, created_at::text
       FROM oakridge.workflow_attempt WHERE root_workflow_id = $1`,
      [root_workflow_id],
    );
    return rows[0] ?? null;
  }

  async list_for_run(run_id: WorkflowRunId): Promise<readonly WorkflowAttempt[]> {
    return this.sql.query<WorkflowAttempt>(
      `SELECT root_workflow_id, run_id::text AS run_id,
              forked_from_root_workflow_id, created_at::text
       FROM oakridge.workflow_attempt WHERE run_id = $1 ORDER BY created_at`,
      [run_id],
    );
  }
}

export class PostgresStageInstanceRepository implements StageInstanceRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async start(input: StartStageInstance): Promise<StageInstance> {
    const rows = await this.sql.query<StageRow>(
      `INSERT INTO oakridge.stage_instance
         (id, run_id, stage_key, stage_type, stage_contract, attempt_root_workflow_id, coordinator_workflow_id, started_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::timestamptz)
       ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
       RETURNING id, run_id, stage_key, stage_type, started_at::text, ended_at::text, outcome`,
      [input.id, input.run_id, input.stage_key, input.stage_type, input.stage_contract, input.attempt_root_workflow_id, input.coordinator_workflow_id, input.started_at],
    );
    if (!rows[0]) throw new Error(`stage instance ${input.id} was not returned`);
    return decodeStage(rows[0]);
  }

  async finish(id: StageInstanceId, ended_at: string, outcome: StageOutcome): Promise<StageInstance> {
    const rows = await this.sql.query<StageRow>(
      `UPDATE oakridge.stage_instance
       SET ended_at = $2::timestamptz, outcome = $3::jsonb
       WHERE id = $1 AND (ended_at IS NULL OR (ended_at = $2::timestamptz AND outcome = $3::jsonb))
       RETURNING id, run_id, stage_key, stage_type, started_at::text, ended_at::text, outcome`,
      [id, ended_at, outcome],
    );
    if (!rows[0]) throw new Error(`stage instance ${id} is missing or already finished with another outcome`);
    return decodeStage(rows[0]);
  }

  async find_by_id(id: StageInstanceId): Promise<StageInstance | null> {
    const rows = await this.sql.query<StageRow>(
      "SELECT id, run_id, stage_key, stage_type, started_at::text, ended_at::text, outcome FROM oakridge.stage_instance WHERE id = $1",
      [id],
    );
    return rows[0] ? decodeStage(rows[0]) : null;
  }
}

interface ArtifactIdentityRow { readonly id: string; readonly emission_payload_hash: string }

export class PostgresArtifactRepository implements ArtifactRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async insert_idempotent(input: InsertArtifact): Promise<ArtifactId> {
    const rows = await this.sql.query<ArtifactIdentityRow>(
      `INSERT INTO oakridge.artifact
         (id, run_id, stage_instance_id, execution_id, unit_id, output_name,
          artifact_type, body, version, emission_idempotency_key, emission_payload_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 1, $9, $10)
       ON CONFLICT (stage_instance_id, execution_id, unit_id, output_name, emission_idempotency_key)
       DO UPDATE SET id = oakridge.artifact.id
       RETURNING id, emission_payload_hash`,
      [input.id, input.run_id, input.stage_instance_id, input.execution_id, input.unit_id, input.output_name, input.artifact_type, input.body, input.emission_idempotency_key, input.emission_payload_hash],
    );
    const row = rows[0];
    if (!row) throw new Error("artifact insert returned no identity");
    if (row.emission_payload_hash !== input.emission_payload_hash) throw new Error("artifact idempotency key was reused with a different payload");
    return row.id as ArtifactId;
  }
}

interface ArtifactRow {
  readonly id: string;
  readonly chain_id: string;
  readonly run_id: string;
  readonly stage_instance_id: string;
  readonly execution_id: string;
  readonly unit_id: string;
  readonly output_name: string;
  readonly artifact_type: string;
  readonly label: string | null;
  readonly body: ArtifactRevision["body"];
  readonly version: number;
  readonly parent_artifact_id: string | null;
  readonly emission_payload_hash: string;
  readonly created_at: string;
}

const artifactColumns = `id,
  COALESCE((WITH RECURSIVE ancestors AS (
    SELECT root.id, root.parent_artifact_id FROM oakridge.artifact root WHERE root.id = artifact.id
    UNION ALL SELECT parent.id, parent.parent_artifact_id FROM oakridge.artifact parent JOIN ancestors child ON parent.id = child.parent_artifact_id
  ) SELECT id FROM ancestors WHERE parent_artifact_id IS NULL LIMIT 1), id) AS chain_id,
  run_id, stage_instance_id, execution_id, unit_id, output_name, artifact_type,
  label, body, version, parent_artifact_id, emission_payload_hash, created_at::text`;

const decodeArtifact = (row: ArtifactRow): ArtifactRevision => ({
  id: row.id as ArtifactRevision["id"], chain_id: row.chain_id as ArtifactRevision["chain_id"],
  run_id: row.run_id as ArtifactRevision["run_id"], stage_instance_id: row.stage_instance_id as ArtifactRevision["stage_instance_id"],
  execution_id: row.execution_id as ArtifactRevision["execution_id"], unit_id: row.unit_id as ArtifactRevision["unit_id"],
  output_name: row.output_name, artifact_type: row.artifact_type, label: row.label, body: row.body,
  version: row.version, parent_artifact_id: row.parent_artifact_id as ArtifactRevision["parent_artifact_id"], created_at: row.created_at,
});

export class PostgresArtifactRevisionRepository implements ArtifactRevisionRepository {
  constructor(private readonly sql: TransactionalSqlExecutor) {}

  async emit_revision(id: ArtifactId, emission: ArtifactEmission, created_at: string): Promise<ArtifactRevision> {
    return this.sql.transaction(async (transaction) => {
      const resourceKey = `${emission.stage_instance_id}:${emission.execution_id}:${emission.unit_id}:${emission.output_name}`;
      await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [resourceKey]);
      const tips = await transaction.query<ArtifactRow>(
        `SELECT ${artifactColumns} FROM oakridge.artifact artifact
         WHERE stage_instance_id = $1 AND execution_id = $2 AND unit_id = $3 AND output_name = $4
         ORDER BY version DESC LIMIT 1`,
        [emission.stage_instance_id, emission.execution_id, emission.unit_id, emission.output_name],
      );
      const tip = tips[0];
      if (tip?.emission_payload_hash === emission.payload_hash) return decodeArtifact(tip);
      const version = (tip?.version ?? 0) + 1;
      const rows = await transaction.query<ArtifactRow>(
        `INSERT INTO oakridge.artifact
           (id, run_id, stage_instance_id, execution_id, unit_id, output_name, artifact_type,
            body, label, version, parent_artifact_id, emission_idempotency_key, emission_payload_hash, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14::timestamptz)
         RETURNING ${artifactColumns}`,
        [id, emission.run_id, emission.stage_instance_id, emission.execution_id, emission.unit_id, emission.output_name, emission.artifact_type, emission.body, emission.label, version, tip?.id ?? null, emission.idempotency_key, emission.payload_hash, created_at],
      );
      if (!rows[0]) throw new Error("artifact revision insert returned no row");
      return decodeArtifact(rows[0]);
    });
  }

  async find_tip(stage_instance_id: StageInstanceId, execution_id: string, unit_id: string, output_name: string): Promise<ArtifactRevision | null> {
    const rows = await this.sql.query<ArtifactRow>(`SELECT ${artifactColumns} FROM oakridge.artifact artifact WHERE stage_instance_id = $1 AND execution_id = $2 AND unit_id = $3 AND output_name = $4 ORDER BY version DESC LIMIT 1`, [stage_instance_id, execution_id, unit_id, output_name]);
    return rows[0] ? decodeArtifact(rows[0]) : null;
  }

  async list_chain(chain_id: ArtifactId): Promise<readonly ArtifactRevision[]> {
    const rows = await this.sql.query<ArtifactRow>(
      `WITH RECURSIVE chain AS (
         SELECT * FROM oakridge.artifact WHERE id = $1
         UNION ALL SELECT child.* FROM oakridge.artifact child JOIN chain parent ON child.parent_artifact_id = parent.id
       ) SELECT ${artifactColumns} FROM chain artifact ORDER BY version`, [chain_id],
    );
    return rows.map(decodeArtifact);
  }

  async find_by_id(id: ArtifactId): Promise<ArtifactRevision | null> {
    const rows = await this.sql.query<ArtifactRow>(`SELECT ${artifactColumns} FROM oakridge.artifact artifact WHERE id = $1`, [id]);
    return rows[0] ? decodeArtifact(rows[0]) : null;
  }
}

interface ExecutionArtifactContextRow {
  readonly run_id: string;
  readonly stage_key: string;
  readonly operator_role: string | null;
  readonly stage_instance_id: string;
  readonly execution_id: string;
  readonly unit_id: string;
  readonly executor_type: string;
  readonly execution_workflow_id: string;
  readonly inputs: ExecutionArtifactContext["inputs"];
  readonly outputs: ExecutionArtifactContext["outputs"];
}

export class PostgresExecutionArtifactContextRepository implements ExecutionArtifactContextRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async find_for_emit(stage_instance_id: StageInstanceId, unit_id: ExecutionArtifactContext["unit_id"]): Promise<ExecutionArtifactContext | null> {
    const rows = await this.sql.query<ExecutionArtifactContextRow>(
      `SELECT stage.run_id, stage.stage_key, stage.stage_contract->>'operator_role' AS operator_role,
              projection.stage_instance_id, projection.execution_id,
              projection.unit_id, projection.executor_type, projection.execution_workflow_id,
              projection.input_artifacts AS inputs,
              stage.stage_contract->'outputs' AS outputs
       FROM oakridge.executor_projection projection
       JOIN oakridge.stage_instance stage ON stage.id = projection.stage_instance_id
       WHERE projection.stage_instance_id = $1
         AND (projection.unit_id = $2 OR (
           stage.stage_contract->'materialization'->>'kind' = 'artifact_collection'
           AND EXISTS (
             SELECT 1 FROM jsonb_array_elements(projection.unit_parameters) item
             WHERE item #>> string_to_array(trim(both '/' from stage.stage_contract->'materialization'->>'id_path'), '/') = $2
           )
         ))`,
      [stage_instance_id, unit_id],
    );
    const row = rows[0];
    return row ? {
      run_id: row.run_id as ExecutionArtifactContext["run_id"], stage_key: row.stage_key, operator_role: row.operator_role,
      stage_instance_id: row.stage_instance_id as ExecutionArtifactContext["stage_instance_id"],
      execution_id: row.execution_id as ExecutionArtifactContext["execution_id"], unit_id: unit_id,
      executor_type: row.executor_type, execution_workflow_id: row.execution_workflow_id, inputs: row.inputs, outputs: row.outputs,
    } : null;
  }
}

export class PostgresExecutionProjectionRepository implements ExecutionProjectionRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async record(request: ExecutionRequest, execution_workflow_id: string, parameters: JsonValue): Promise<void> {
    await this.sql.query(
      `INSERT INTO oakridge.executor_projection
         (execution_id, execution_workflow_id, stage_instance_id, unit_id, executor_type, unit_parameters, input_artifacts)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)
       ON CONFLICT (execution_id) DO UPDATE SET
         execution_workflow_id = EXCLUDED.execution_workflow_id,
         unit_parameters = EXCLUDED.unit_parameters,
         input_artifacts = EXCLUDED.input_artifacts,
         updated_at = now()`,
      [request.execution_id, execution_workflow_id, request.stage_instance_id, request.unit_id, request.executor_type, parameters, request.inputs],
    );
  }

  async attach_external(execution_id: ExecutionId, reference: ExternalExecutionReference): Promise<void> {
    await this.sql.query("UPDATE oakridge.executor_projection SET external_reference = $2::jsonb, updated_at = now() WHERE execution_id = $1", [execution_id, reference]);
  }

  async record_terminal(execution_id: ExecutionId, observation: ExecutorTerminalObservation): Promise<void> {
    await this.sql.query("UPDATE oakridge.executor_projection SET terminal_observation = $2::jsonb, updated_at = now() WHERE execution_id = $1", [execution_id, observation]);
  }
}

export class PostgresRerunTargetRepository implements RerunTargetRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async find_unit_target(stage_instance_id: StageInstanceId, unit_id: UnitId): Promise<UnitRerunTarget | null> {
    const rows = await this.sql.query<{ readonly run_id: string; readonly stage_instance_id: string; readonly unit_id: string; readonly execution_id: string; readonly execution_workflow_id: string; readonly stage_coordinator_workflow_id: string }>(
      `SELECT stage.run_id::text, stage.id::text AS stage_instance_id, projection.unit_id,
              projection.execution_id, projection.execution_workflow_id,
              stage.coordinator_workflow_id AS stage_coordinator_workflow_id
       FROM oakridge.stage_instance stage
       JOIN oakridge.executor_projection projection ON projection.stage_instance_id = stage.id
       WHERE stage.id = $1 AND projection.unit_id = $2`,
      [stage_instance_id, unit_id],
    );
    const row = rows[0];
    return row ? { run_id: row.run_id as WorkflowRunId, stage_instance_id: row.stage_instance_id as StageInstanceId,
      unit_id: row.unit_id as UnitId, execution_id: row.execution_id as ExecutionId,
      execution_workflow_id: row.execution_workflow_id, stage_coordinator_workflow_id: row.stage_coordinator_workflow_id } : null;
  }

  async replace_execution_workflow(execution_id: ExecutionId, replacement_workflow_id: string): Promise<void> {
    await this.sql.query(
      `UPDATE oakridge.executor_projection
       SET execution_workflow_id = $2, external_reference = NULL,
           terminal_observation = NULL, updated_at = now()
       WHERE execution_id = $1`,
      [execution_id, replacement_workflow_id],
    );
  }
}

export class PostgresResumeArtifactRepository implements ResumeArtifactRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async list_latest_for_stages(run_id: WorkflowRunId, stage_keys: readonly string[]): Promise<readonly (ArtifactRevision & { readonly stage_key: string })[]> {
    const rows = await this.sql.query<ArtifactRow & { readonly stage_key: string }>(
      `SELECT DISTINCT ON (stage.stage_key, artifact.unit_id, artifact.output_name)
              artifact.id::text,
              COALESCE((WITH RECURSIVE ancestors AS (
                SELECT root.id, root.parent_artifact_id FROM oakridge.artifact root WHERE root.id = artifact.id
                UNION ALL SELECT parent.id, parent.parent_artifact_id FROM oakridge.artifact parent JOIN ancestors child ON parent.id = child.parent_artifact_id
              ) SELECT id::text FROM ancestors WHERE parent_artifact_id IS NULL LIMIT 1), artifact.id::text) AS chain_id,
              artifact.run_id::text,
              artifact.stage_instance_id::text, artifact.execution_id, artifact.unit_id,
              artifact.output_name, artifact.artifact_type, artifact.label, artifact.body,
              artifact.version, artifact.parent_artifact_id::text, artifact.emission_payload_hash,
              artifact.created_at::text, stage.stage_key
       FROM oakridge.artifact artifact
       JOIN oakridge.stage_instance stage ON stage.id = artifact.stage_instance_id
       WHERE artifact.run_id = $1 AND stage.stage_key = ANY($2::text[])
       ORDER BY stage.stage_key, artifact.unit_id, artifact.output_name, artifact.created_at DESC, artifact.version DESC`,
      [run_id, stage_keys],
    );
    return rows.map((row) => ({ ...decodeArtifact(row), stage_key: row.stage_key }));
  }
}

export class PostgresCancellationTargetRepository implements CancellationTargetRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async list_for_attempt(root_workflow_id: string): Promise<readonly CancellationExecutionTarget[]> {
    const rows = await this.sql.query<{ readonly execution_id: string; readonly executor_type: string; readonly external_reference: ExternalExecutionReference | null }>(
      `SELECT projection.execution_id, projection.executor_type, projection.external_reference
       FROM oakridge.executor_projection projection
       JOIN oakridge.stage_instance stage ON stage.id = projection.stage_instance_id
       WHERE stage.attempt_root_workflow_id = $1`, [root_workflow_id]);
    return rows.map((row) => ({ execution_id: row.execution_id as ExecutionId, executor_type: row.executor_type, external_reference: row.external_reference }));
  }

  async finish_started_stages(root_workflow_id: string, ended_at: string, reason: string | null): Promise<void> {
    await this.sql.query(
      `UPDATE oakridge.stage_instance
       SET ended_at = $2::timestamptz,
           outcome = jsonb_build_object('kind', 'cancelled', 'reason', $3::text)
       WHERE attempt_root_workflow_id = $1 AND ended_at IS NULL`,
      [root_workflow_id, ended_at, reason],
    );
  }
}
