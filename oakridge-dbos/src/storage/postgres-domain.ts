import type { ArtifactId, StageInstanceId, UnitId, WorkflowRunId } from "../domain/primitives";
import type { ArtifactCoordinate, ArtifactEmission, ArtifactEmissionDelivery, ArtifactLifecycleNotification, ArtifactRevision, EmitArtifactRevisionResult, PendingArtifactNotification, ReleaseArtifactResult, WithdrawArtifactRequest, WithdrawArtifactResult } from "../domain/artifacts";
import type { StageInstance, StageOutcome } from "../domain/workflow";
import type {
  ArtifactRevisionRepository,
  ExecutionArtifactContextRepository,
  ExecutionArtifactContext,
  ExecutionProjectionRepository,
  StageAdmissionTargetRepository,
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
import { err, ok, type ExecutionId, type JsonValue } from "../domain/primitives";
import type { ExecutionRequest, ExecutorTerminalObservation, ExternalExecutionReference } from "../domain/execution";
import type { SqlExecutor, TransactionalSqlExecutor } from "./sql-executor";
import type { CancellationExecutionTarget, CancellationWaitTarget, UnitRerunTarget } from "../domain/rerun";
import type { CreateWorkflowRunResult, DeleteRunResult, PendingRunLaunch, PersistWorkflowRunLaunch, RunLaunchCommand, SetRunArchiveResult, WorkflowRunLaunchRecord, WorkflowRunListFilter } from "../domain/runs";
import type { EpicWorkflowProfile } from "../domain/epic";

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
  constructor(private readonly sql: TransactionalSqlExecutor) {}

  private readonly launchColumns = `run.id::text, run.workflow_definition_id::text,
    run.project_id::text, run.context, attempt.root_workflow_id,
    run.archived, run.created_at::text`;

  private decodeLaunch(row: {
    readonly id: string; readonly workflow_definition_id: string; readonly project_id: string | null;
    readonly context: JsonValue; readonly root_workflow_id: string; readonly archived: boolean; readonly created_at: string;
  }): WorkflowRunLaunchRecord {
    return { id: row.id as WorkflowRunId, workflow_definition_id: row.workflow_definition_id as WorkflowRunLaunchRecord["workflow_definition_id"],
      project_id: row.project_id as WorkflowRunLaunchRecord["project_id"], context: row.context,
      root_workflow_id: row.root_workflow_id, archived: row.archived, created_at: row.created_at };
  }

  async create_with_initial_attempt(input: PersistWorkflowRunLaunch): Promise<CreateWorkflowRunResult> {
    return this.sql.transaction(async (transaction) => {
      await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`workflow-run:${input.run.id}`]);
      const definitions = await transaction.query<{ readonly archived: boolean; readonly version: number }>(
        "SELECT archived, version FROM oakridge.workflow_definition WHERE id = $1 FOR SHARE", [input.run.workflow_definition_id]);
      const definition = definitions[0];
      if (!definition) return err({ operation: "create_workflow_run", kind: "definition_not_found", detail: `workflow definition '${input.run.workflow_definition_id}' was not found` });
      if (definition.version !== input.workflow_definition_version) {
        return err({ operation: "create_workflow_run", kind: "idempotency_conflict", detail: `workflow definition '${input.run.workflow_definition_id}' version changed during launch` });
      }
      const existingRows = await transaction.query<{
        readonly id: string; readonly workflow_definition_id: string; readonly project_id: string | null; readonly context: JsonValue;
        readonly root_workflow_id: string; readonly archived: boolean; readonly created_at: string;
        readonly immutable_matches: boolean;
      }>(
        // `created_at` is deliberately absent: it is stamped by whichever caller
        // reaches the server first, not supplied by the request. Two concurrent
        // launches carrying the same Idempotency-Key are the same launch even
        // though each stamped its own `now()`, so comparing it would 409 the
        // loser of a race that in fact succeeded.
        `SELECT ${this.launchColumns},
                run.workflow_definition_id = $2::uuid
                AND run.project_id IS NOT DISTINCT FROM $3::uuid
                AND run.context = $4::jsonb
                AND attempt.root_workflow_id = $5 AS immutable_matches
         FROM oakridge.workflow_run run
         LEFT JOIN oakridge.workflow_attempt attempt ON attempt.run_id = run.id
           AND attempt.forked_from_root_workflow_id IS NULL
         WHERE run.id = $1`,
        [input.run.id, input.run.workflow_definition_id, input.run.project_id, input.run.context,
          input.run.root_workflow_id],
      );
      const existing = existingRows[0];
      if (existing) {
        if (!existing.immutable_matches || !await this.profileMatches(transaction, input) || !await this.launchCommandMatches(transaction, input)) {
          return err({ operation: "create_workflow_run", kind: "idempotency_conflict", detail: `workflow run '${input.run.id}' conflicts with immutable stored launch data` });
        }
        return ok({ kind: "replayed", run: this.decodeLaunch(existing), epic_profile: await this.findProfile(transaction, input.run.id) });
      }
      if (definition.archived) return err({ operation: "create_workflow_run", kind: "definition_archived", detail: `workflow definition '${input.run.workflow_definition_id}' is archived` });
      if (input.run.project_id) {
        const projects = await transaction.query<{ readonly id: string }>("SELECT id::text FROM oakridge.project WHERE id = $1 FOR SHARE", [input.run.project_id]);
        if (!projects[0]) return err({ operation: "create_workflow_run", kind: "project_not_found", detail: `project '${input.run.project_id}' was not found` });
      }

      await transaction.query(
        `INSERT INTO oakridge.workflow_run
           (id, workflow_definition_id, project_id, context, archived, created_at)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6::timestamptz)`,
        [input.run.id, input.run.workflow_definition_id, input.run.project_id, input.run.context,
          input.run.archived, input.run.created_at],
      );
      if (input.epic_profile) await this.insertProfile(transaction, input.epic_profile);
      await transaction.query(
        `INSERT INTO oakridge.workflow_attempt
           (root_workflow_id, run_id, forked_from_root_workflow_id, created_at)
         VALUES ($1,$2,NULL,$3::timestamptz)`,
        [input.run.root_workflow_id, input.run.id, input.run.created_at],
      );
      const notification = this.launchCommand(input);
      const idempotencyKey = `run:${input.run.id}:launch:${input.run.root_workflow_id}`;
      await transaction.query(
        `INSERT INTO oakridge.command_outbox
           (id, command_type, idempotency_key, target_workflow_id, payload, created_at)
         VALUES (md5($1)::uuid, 'run_launch', $1, $2, $3::jsonb, $4::timestamptz)`,
        [idempotencyKey, input.run.root_workflow_id, notification, input.run.created_at],
      );
      return ok({ kind: "created", run: input.run, epic_profile: input.epic_profile });
    });
  }

  async find_launch_by_id(id: WorkflowRunId): Promise<WorkflowRunLaunchRecord | null> {
    const rows = await this.sql.query<Parameters<PostgresWorkflowRunRepository["decodeLaunch"]>[0]>(
      `SELECT ${this.launchColumns} FROM oakridge.workflow_run run
       JOIN oakridge.workflow_attempt attempt ON attempt.run_id = run.id AND attempt.forked_from_root_workflow_id IS NULL
       WHERE run.id = $1`, [id]);
    return rows[0] ? this.decodeLaunch(rows[0]) : null;
  }

  async list(filter: WorkflowRunListFilter = { archived: false }): Promise<readonly WorkflowRunLaunchRecord[]> {
    const rows = await this.sql.query<Parameters<PostgresWorkflowRunRepository["decodeLaunch"]>[0]>(
      `SELECT ${this.launchColumns} FROM oakridge.workflow_run run
       JOIN oakridge.workflow_attempt attempt ON attempt.run_id = run.id AND attempt.forked_from_root_workflow_id IS NULL
       WHERE ($1::boolean IS NULL OR run.archived = $1)
         AND ($2::uuid IS NULL OR run.workflow_definition_id = $2)
         AND ($3::uuid IS NULL OR run.project_id = $3)
       ORDER BY run.created_at DESC, run.id`,
      [filter.archived, filter.workflow_definition_id ?? null, filter.project_id ?? null]);
    return rows.map((row) => this.decodeLaunch(row));
  }

  async set_archived(id: WorkflowRunId, archived: boolean): Promise<SetRunArchiveResult> {
    const rows = await this.sql.query<{ readonly archived: boolean; readonly changed: boolean }>(
      `WITH existing AS (
         SELECT archived FROM oakridge.workflow_run WHERE id = $1 FOR UPDATE
       ), updated AS (
         UPDATE oakridge.workflow_run SET archived = $2 WHERE id = $1 RETURNING archived
       )
       SELECT updated.archived, existing.archived IS DISTINCT FROM updated.archived AS changed
       FROM existing JOIN updated ON true`, [id, archived]);
    if (!rows[0]) return { kind: "not_found", run_id: id };
    return { kind: rows[0].changed ? "updated" : "unchanged", run_id: id, archived: rows[0].archived };
  }

  async delete_terminal(id: WorkflowRunId): Promise<DeleteRunResult> {
    return this.sql.transaction(async (transaction) => {
      const runs = await transaction.query<{ readonly id: string }>("SELECT id::text FROM oakridge.workflow_run WHERE id = $1 FOR UPDATE", [id]);
      if (!runs[0]) return { kind: "already_deleted", run_id: id };
      const blockers = await transaction.query<{ readonly active_attempts: string; readonly active_external: string; readonly pending_commands: string }>(
        `SELECT
           count(DISTINCT attempt.root_workflow_id) FILTER (WHERE status.status IS NULL OR status.status NOT IN ('SUCCESS','ERROR','CANCELLED','MAX_RECOVERY_ATTEMPTS_EXCEEDED'))::text AS active_attempts,
           count(DISTINCT projection.execution_id) FILTER (WHERE projection.external_reference IS NOT NULL AND projection.terminal_observation IS NULL)::text AS active_external,
           count(DISTINCT command.id) FILTER (WHERE command.delivered_at IS NULL)::text AS pending_commands
         FROM oakridge.workflow_attempt attempt
         LEFT JOIN dbos.workflow_status status ON status.workflow_uuid = attempt.root_workflow_id
         LEFT JOIN oakridge.stage_instance stage ON stage.run_id = attempt.run_id
         LEFT JOIN oakridge.executor_projection projection ON projection.stage_instance_id = stage.id
         LEFT JOIN oakridge.command_outbox command ON command.target_workflow_id IN (attempt.root_workflow_id, projection.execution_workflow_id)
         WHERE attempt.run_id = $1`, [id]);
      const blocker = blockers[0] ?? { active_attempts: "0", active_external: "0", pending_commands: "0" };
      if (Number(blocker.active_external) > 0) return { kind: "external_execution_conflict", run_id: id, detail: "run still owns an unterminated external execution" };
      if (Number(blocker.active_attempts) > 0) return { kind: "active_conflict", run_id: id, detail: "run has an active DBOS workflow attempt" };
      if (Number(blocker.pending_commands) > 0) return { kind: "cancellation_pending", run_id: id, detail: "run still owns pending durable commands" };
      await transaction.query(
        `DELETE FROM oakridge.command_outbox command
         WHERE command.target_workflow_id IN (
           SELECT attempt.root_workflow_id FROM oakridge.workflow_attempt attempt WHERE attempt.run_id = $1
           UNION SELECT projection.execution_workflow_id FROM oakridge.executor_projection projection
             JOIN oakridge.stage_instance stage ON stage.id = projection.stage_instance_id WHERE stage.run_id = $1)`, [id]);
      await transaction.query("DELETE FROM oakridge.workflow_run WHERE id = $1", [id]);
      return { kind: "deleted", run_id: id };
    });
  }

  async claim_pending_launches(worker_id: string, claimed_at: string, claimed_until: string, limit: number): Promise<readonly PendingRunLaunch[]> {
    return this.sql.transaction(async (transaction) => transaction.query<PendingRunLaunch>(
      `WITH candidates AS (
         SELECT candidate.id
         FROM oakridge.command_outbox candidate
         WHERE candidate.command_type = 'run_launch'
           AND candidate.delivered_at IS NULL
           AND candidate.next_attempt_at <= $2::timestamptz
           AND (candidate.claimed_until IS NULL OR candidate.claimed_until <= $2::timestamptz)
         ORDER BY candidate.sequence_id
         FOR UPDATE SKIP LOCKED
         LIMIT $4
       ), claimed AS (
         UPDATE oakridge.command_outbox command
         SET claimed_by = $1, claimed_until = $3::timestamptz, attempt_count = attempt_count + 1
         FROM candidates WHERE command.id = candidates.id
         RETURNING command.id::text, command.target_workflow_id, command.payload AS command, command.idempotency_key, command.sequence_id
       )
       SELECT id, target_workflow_id, command, idempotency_key FROM claimed ORDER BY sequence_id`,
      [worker_id, claimed_at, claimed_until, limit],
    ));
  }

  async mark_launch_delivered(id: string, worker_id: string, delivered_at: string): Promise<void> {
    await this.sql.query(
      `UPDATE oakridge.command_outbox
       SET delivered_at = $3::timestamptz, claimed_by = NULL, claimed_until = NULL, last_error = NULL
       WHERE id = $1::uuid AND command_type = 'run_launch' AND claimed_by = $2 AND delivered_at IS NULL`,
      [id, worker_id, delivered_at]);
  }

  async mark_launch_failed(id: string, worker_id: string, error: string, next_attempt_at: string): Promise<void> {
    await this.sql.query(
      `UPDATE oakridge.command_outbox
       SET claimed_by = NULL, claimed_until = NULL, last_error = $3, next_attempt_at = $4::timestamptz
       WHERE id = $1::uuid AND command_type = 'run_launch' AND claimed_by = $2 AND delivered_at IS NULL`,
      [id, worker_id, error, next_attempt_at]);
  }

  private async findProfile(transaction: SqlExecutor, runId: WorkflowRunId): Promise<EpicWorkflowProfile | null> {
    const rows = await transaction.query<EpicWorkflowProfile>(
      `SELECT id::text, workflow_run_id::text, title, slug, lifecycle_state, final_merge_policy,
              repositories, created_at::text, updated_at::text
       FROM oakridge.epic_workflow_profile WHERE workflow_run_id = $1`, [runId]);
    return rows[0] ?? null;
  }

  private async profileMatches(transaction: SqlExecutor, input: PersistWorkflowRunLaunch): Promise<boolean> {
    if (!input.epic_profile) {
      const rows = await transaction.query<{ readonly exists: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM oakridge.epic_workflow_profile WHERE workflow_run_id = $1) AS exists", [input.run.id]);
      return rows[0]?.exists === false;
    }
    const profile = input.epic_profile;
    // Timestamps are excluded for the same reason as on the run itself: the
    // profile inherits the launch's server-stamped `created_at`, so a race
    // between two identical requests would otherwise read as a conflict.
    const rows = await transaction.query<{ readonly matches: boolean }>(
      `SELECT id = $2::uuid AND title = $3 AND slug = $4 AND lifecycle_state = $5
              AND final_merge_policy = $6 AND repositories = $7::jsonb AS matches
       FROM oakridge.epic_workflow_profile WHERE workflow_run_id = $1`,
      [input.run.id, profile.id, profile.title, profile.slug, profile.lifecycle_state, profile.final_merge_policy,
        JSON.stringify(profile.repositories)]);
    return rows[0]?.matches === true;
  }

  private async launchCommandMatches(transaction: SqlExecutor, input: PersistWorkflowRunLaunch): Promise<boolean> {
    const { created_at: _stampedByTheWinner, ...expected } = this.launchCommand(input);
    const idempotencyKey = `run:${input.run.id}:launch:${input.run.root_workflow_id}`;
    // The stored payload carries the winner's `created_at`; a replaying caller
    // stamped its own. Comparing everything except that timestamp is what makes
    // the two requests recognisably the same launch.
    const rows = await transaction.query<{ readonly matches: boolean }>(
      `SELECT command_type = 'run_launch' AND target_workflow_id = $2
              AND payload - 'created_at' = $3::jsonb AS matches
       FROM oakridge.command_outbox WHERE idempotency_key = $1`,
      [idempotencyKey, input.run.root_workflow_id, expected]);
    return rows[0]?.matches === true;
  }

  private launchCommand(input: PersistWorkflowRunLaunch): RunLaunchCommand {
    return { kind: "launch_run", run_id: input.run.id, workflow_definition_id: input.run.workflow_definition_id,
      workflow_definition_version: input.workflow_definition_version,
      root_workflow_id: input.run.root_workflow_id, context: input.run.context, created_at: input.run.created_at,
      application_version: input.application_version };
  }

  private async insertProfile(transaction: SqlExecutor, profile: EpicWorkflowProfile): Promise<void> {
    await transaction.query(
      `INSERT INTO oakridge.epic_workflow_profile
         (id, workflow_run_id, title, slug, lifecycle_state, final_merge_policy, repositories, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::timestamptz,$9::timestamptz)`,
      [profile.id, profile.workflow_run_id, profile.title, profile.slug, profile.lifecycle_state,
        profile.final_merge_policy, JSON.stringify(profile.repositories), profile.created_at, profile.updated_at]);
  }

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

  /**
   * Record an attempt's terminal outcome. Idempotent by design: the run
   * workflow's finishing step is replayable, and a recovered workflow must be
   * able to write the same outcome again without raising.
   */
  async finish(root_workflow_id: string, ended_at: string, outcome: StageOutcome): Promise<void> {
    await this.sql.query(
      `UPDATE oakridge.workflow_attempt
       SET ended_at = $2::timestamptz, outcome = $3::jsonb
       WHERE root_workflow_id = $1 AND ended_at IS NULL`,
      [root_workflow_id, ended_at, outcome],
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

export class PostgresStageAdmissionTargetRepository implements StageAdmissionTargetRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async find_coordinator_workflow_id(stage_instance_id: StageInstanceId): Promise<string | null> {
    const rows = await this.sql.query<{ readonly coordinator_workflow_id: string }>(
      "SELECT coordinator_workflow_id FROM oakridge.stage_instance WHERE id = $1",
      [stage_instance_id],
    );
    return rows[0]?.coordinator_workflow_id ?? null;
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
  readonly lifecycle_state: "current" | "superseded" | "withdrawn" | "released";
  readonly superseded_by_artifact_id: string | null;
  readonly withdrawn_actor: string | null;
  readonly withdrawn_reason: string | null;
  readonly withdrawn_at: string | null;
  readonly released_at: string | null;
  readonly created_at: string;
}

const artifactColumns = `id,
  COALESCE((WITH RECURSIVE ancestors AS (
    SELECT root.id, root.parent_artifact_id FROM oakridge.artifact root WHERE root.id = artifact.id
    UNION ALL SELECT parent.id, parent.parent_artifact_id FROM oakridge.artifact parent JOIN ancestors child ON parent.id = child.parent_artifact_id
  ) SELECT id FROM ancestors WHERE parent_artifact_id IS NULL LIMIT 1), id) AS chain_id,
  run_id, stage_instance_id, execution_id, unit_id, output_name, artifact_type,
  label, body, version, parent_artifact_id, emission_payload_hash, lifecycle_state,
  superseded_by_artifact_id, withdrawn_actor, withdrawn_reason,
  withdrawn_at::text, released_at::text, created_at::text`;

/** Bind order for the four coordinate columns, in one place so it cannot drift. */
const artifactCoordinateParameters = (coordinate: ArtifactCoordinate): readonly unknown[] =>
  [coordinate.stage_instance_id, coordinate.execution_id, coordinate.unit_id, coordinate.output_name];

const decodeArtifactLifecycle = (row: ArtifactRow): ArtifactRevision["lifecycle"] => {
  if (row.lifecycle_state === "current") return { kind: "current" };
  if (row.lifecycle_state === "superseded" && row.superseded_by_artifact_id) {
    return { kind: "superseded", superseded_by_artifact_id: row.superseded_by_artifact_id as ArtifactId };
  }
  if (row.lifecycle_state === "withdrawn" && row.withdrawn_actor && row.withdrawn_reason && row.withdrawn_at) {
    return { kind: "withdrawn", actor: row.withdrawn_actor, reason: row.withdrawn_reason, withdrawn_at: row.withdrawn_at };
  }
  if (row.lifecycle_state === "released" && row.released_at) return { kind: "released", released_at: row.released_at };
  throw new Error(`artifact '${row.id}' has invalid lifecycle metadata for '${row.lifecycle_state}'`);
};

const decodeArtifact = (row: ArtifactRow): ArtifactRevision => ({
  id: row.id as ArtifactRevision["id"], chain_id: row.chain_id as ArtifactRevision["chain_id"],
  run_id: row.run_id as ArtifactRevision["run_id"], stage_instance_id: row.stage_instance_id as ArtifactRevision["stage_instance_id"],
  execution_id: row.execution_id as ArtifactRevision["execution_id"], unit_id: row.unit_id as ArtifactRevision["unit_id"],
  output_name: row.output_name, artifact_type: row.artifact_type, label: row.label, body: row.body,
  version: row.version, parent_artifact_id: row.parent_artifact_id as ArtifactRevision["parent_artifact_id"],
  lifecycle: decodeArtifactLifecycle(row), created_at: row.created_at,
});

export class PostgresArtifactRevisionRepository implements ArtifactRevisionRepository {
  constructor(private readonly sql: TransactionalSqlExecutor) {}

  async emit_revision(id: ArtifactId, emission: ArtifactEmission, created_at: string, delivery: ArtifactEmissionDelivery): Promise<EmitArtifactRevisionResult> {
    return this.sql.transaction(async (transaction) => {
      const resourceKey = `${emission.stage_instance_id}:${emission.execution_id}:${emission.unit_id}:${emission.output_name}`;
      await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [resourceKey]);
      const stages = await transaction.query<{ readonly ended_at: string | null }>(
        "SELECT ended_at::text FROM oakridge.stage_instance WHERE id = $1 FOR SHARE", [emission.stage_instance_id]);
      if (!stages[0] || stages[0].ended_at !== null) return err({ operation: "emit_artifact_revision", kind: "execution_closed", artifact_id: id, detail: "stage execution is closed" });
      const replayRows = await transaction.query<ArtifactRow>(
        `SELECT ${artifactColumns} FROM oakridge.artifact artifact
         WHERE artifact.id = (
           SELECT replay.artifact_id FROM oakridge.artifact_emission_idempotency replay
           WHERE replay.stage_instance_id = $1 AND replay.execution_id = $2 AND replay.unit_id = $3
             AND replay.output_name = $4 AND replay.idempotency_key = $5
         )`,
        [emission.stage_instance_id, emission.execution_id, emission.unit_id, emission.output_name, emission.idempotency_key],
      );
      const replay = replayRows[0];
      if (replay) {
        if (replay.emission_payload_hash !== emission.payload_hash) return err({ operation: "emit_artifact_revision", kind: "idempotency_conflict", artifact_id: replay.id as ArtifactId, detail: "artifact idempotency key was reused with a different payload" });
        return ok({ kind: "unchanged", artifact: decodeArtifact(replay), superseded_artifact_id: replay.parent_artifact_id as ArtifactId | null });
      }
      const effectiveRows = await transaction.query<ArtifactRow>(
        `SELECT ${artifactColumns} FROM oakridge.artifact artifact
         WHERE stage_instance_id = $1 AND execution_id = $2 AND unit_id = $3 AND output_name = $4
           AND lifecycle_state IN ('current', 'released')`,
        [emission.stage_instance_id, emission.execution_id, emission.unit_id, emission.output_name],
      );
      const effective = effectiveRows[0];
      if (effective?.lifecycle_state === "released") return err({ operation: "emit_artifact_revision", kind: "release_conflict", artifact_id: effective.id as ArtifactId, detail: "released artifact cannot be revised; rerun the execution" });
      const tips = await transaction.query<ArtifactRow>(
        `SELECT ${artifactColumns} FROM oakridge.artifact artifact
         WHERE stage_instance_id = $1 AND execution_id = $2 AND unit_id = $3 AND output_name = $4
         ORDER BY version DESC LIMIT 1`,
        [emission.stage_instance_id, emission.execution_id, emission.unit_id, emission.output_name],
      );
      const tip = tips[0];
      if (effective?.lifecycle_state === "current" && tip?.id !== effective.id) {
        return err({ operation: "emit_artifact_revision", kind: "invariant_conflict", artifact_id: effective.id as ArtifactId, detail: "effective artifact is not the latest chain revision" });
      }
      if (effective?.lifecycle_state === "current" && effective.emission_payload_hash === emission.payload_hash) {
        await this.recordEmissionKey(transaction, emission, effective.id as ArtifactId, created_at);
        return ok({ kind: "unchanged", artifact: decodeArtifact(effective), superseded_artifact_id: effective.parent_artifact_id as ArtifactId | null });
      }
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
      await this.recordEmissionKey(transaction, emission, id, created_at);
      if (effective?.lifecycle_state === "current") {
        await transaction.query(
          `UPDATE oakridge.artifact
           SET lifecycle_state = 'superseded', superseded_by_artifact_id = $2, superseded_at = $3::timestamptz,
               lifecycle_updated_at = $3::timestamptz
           WHERE id = $1 AND lifecycle_state = 'current'`,
          [effective.id, id, created_at],
        );
      }
      const artifact = decodeArtifact(rows[0]);
      const supersededArtifactId = effective?.lifecycle_state === "current" ? effective.id as ArtifactId : null;
      const release = delivery.release.kind === "gate"
        ? { kind: "waiting_gate" as const, artifact, gate_steps: delivery.release.steps }
        : delivery.release.kind === "handoff"
          ? { kind: "waiting_handoff" as const, artifact, downstream_role: delivery.release.downstream_role, external_wait_kind: delivery.release.external_wait_kind }
          : { kind: "released" as const, artifact };
      const notification: ArtifactLifecycleNotification = supersededArtifactId
        ? { kind: "artifact_replaced", invalidated_artifact_id: supersededArtifactId, release }
        : { kind: "artifact_emitted", release };
      const notificationKey = supersededArtifactId
        ? `artifact:${supersededArtifactId}:replaced-by:${artifact.id}`
        : `artifact:${artifact.id}:${release.kind}`;
      await this.enqueueNotification(transaction, delivery.target_workflow_id, notification, notificationKey, created_at);
      return ok({ kind: "emitted", artifact, superseded_artifact_id: supersededArtifactId });
    });
  }

  async withdraw(request: WithdrawArtifactRequest): Promise<WithdrawArtifactResult> {
    return this.sql.transaction(async (transaction) => {
      const rows = await transaction.query<ArtifactRow>(`SELECT ${artifactColumns} FROM oakridge.artifact artifact WHERE id = $1`, [request.artifact_id]);
      const found = rows[0];
      if (!found) return { kind: "not_found", artifact_id: request.artifact_id };
      const resourceKey = `${found.stage_instance_id}:${found.execution_id}:${found.unit_id}:${found.output_name}`;
      await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [resourceKey]);
      const lockedRows = await transaction.query<ArtifactRow>(`SELECT ${artifactColumns} FROM oakridge.artifact artifact WHERE id = $1 FOR UPDATE`, [request.artifact_id]);
      const artifact = lockedRows[0];
      if (!artifact) return { kind: "not_found", artifact_id: request.artifact_id };
      if (artifact.lifecycle_state === "withdrawn") return { kind: "already_withdrawn", artifact: decodeArtifact(artifact) };
      if (artifact.lifecycle_state === "released") return { kind: "release_conflict", artifact_id: request.artifact_id, released_at: artifact.released_at! };
      if (artifact.lifecycle_state !== "current") {
        const current = await transaction.query<{ readonly id: string }>(
          `SELECT id::text FROM oakridge.artifact WHERE stage_instance_id = $1 AND execution_id = $2 AND unit_id = $3 AND output_name = $4 AND lifecycle_state = 'current'`,
          [artifact.stage_instance_id, artifact.execution_id, artifact.unit_id, artifact.output_name],
        );
        return { kind: "not_current", artifact_id: request.artifact_id, current_artifact_id: current[0]?.id as ArtifactId ?? null };
      }
      const updated = await transaction.query<ArtifactRow>(
        `UPDATE oakridge.artifact SET lifecycle_state = 'withdrawn', withdrawn_actor = $2,
           withdrawn_reason = $3, withdrawn_at = $4::timestamptz, lifecycle_updated_at = $4::timestamptz
         WHERE id = $1 AND lifecycle_state = 'current' RETURNING ${artifactColumns}`,
        [request.artifact_id, request.actor, request.reason, request.withdrawn_at],
      );
      if (!updated[0]) throw new Error(`artifact '${request.artifact_id}' changed during withdrawal`);
      const withdrawn = decodeArtifact(updated[0]);
      await this.enqueueNotification(transaction, request.target_workflow_id, {
        kind: "artifact_invalidated", artifact_id: withdrawn.id, output_name: withdrawn.output_name,
        reason: "withdrawn", replacement_artifact_revision_id: null,
      }, `artifact:${withdrawn.id}:withdrawn`, request.withdrawn_at);
      return { kind: "withdrawn", artifact: withdrawn };
    });
  }

  async mark_released(id: ArtifactId, released_at: string): Promise<ReleaseArtifactResult> {
    return this.sql.transaction(async (transaction) => {
      const foundRows = await transaction.query<ArtifactRow>(`SELECT ${artifactColumns} FROM oakridge.artifact artifact WHERE id = $1`, [id]);
      const found = foundRows[0];
      if (!found) return { kind: "not_current", artifact_id: id };
      const resourceKey = `${found.stage_instance_id}:${found.execution_id}:${found.unit_id}:${found.output_name}`;
      await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [resourceKey]);
      const rows = await transaction.query<ArtifactRow>(`SELECT ${artifactColumns} FROM oakridge.artifact artifact WHERE id = $1 FOR UPDATE`, [id]);
      const artifact = rows[0];
      if (!artifact || artifact.lifecycle_state === "superseded" || artifact.lifecycle_state === "withdrawn") return { kind: "not_current", artifact_id: id };
      if (artifact.lifecycle_state === "released") return { kind: "already_released", artifact: decodeArtifact(artifact) };
      const updated = await transaction.query<ArtifactRow>(
        `UPDATE oakridge.artifact SET lifecycle_state = 'released', released_at = $2::timestamptz, lifecycle_updated_at = $2::timestamptz
         WHERE id = $1 AND lifecycle_state = 'current' RETURNING ${artifactColumns}`,
        [id, released_at],
      );
      if (!updated[0]) return { kind: "not_current", artifact_id: id };
      return { kind: "released", artifact: decodeArtifact(updated[0]) };
    });
  }

  async find_tip(coordinate: ArtifactCoordinate): Promise<ArtifactRevision | null> {
    const rows = await this.sql.query<ArtifactRow>(`SELECT ${artifactColumns} FROM oakridge.artifact artifact WHERE stage_instance_id = $1 AND execution_id = $2 AND unit_id = $3 AND output_name = $4 ORDER BY version DESC LIMIT 1`, artifactCoordinateParameters(coordinate));
    return rows[0] ? decodeArtifact(rows[0]) : null;
  }

  async find_current(coordinate: ArtifactCoordinate): Promise<ArtifactRevision | null> {
    const rows = await this.sql.query<ArtifactRow>(`SELECT ${artifactColumns} FROM oakridge.artifact artifact WHERE stage_instance_id = $1 AND execution_id = $2 AND unit_id = $3 AND output_name = $4 AND lifecycle_state = 'current'`, artifactCoordinateParameters(coordinate));
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

  async list_effective_for_run(run_id: WorkflowRunId): Promise<readonly ArtifactRevision[]> {
    const rows = await this.sql.query<ArtifactRow>(
      `SELECT ${artifactColumns} FROM oakridge.artifact artifact
       WHERE run_id = $1 AND lifecycle_state IN ('current', 'released')
       ORDER BY created_at, version`, [run_id]);
    return rows.map(decodeArtifact);
  }

  async claim_pending_notifications(workerId: string, claimedAt: string, claimedUntil: string, limit: number): Promise<readonly PendingArtifactNotification[]> {
    return this.sql.query<PendingArtifactNotification>(
      `WITH candidates AS (
         SELECT candidate.id
         FROM oakridge.command_outbox candidate
         WHERE candidate.command_type = 'artifact_notification'
           AND candidate.delivered_at IS NULL
           AND candidate.next_attempt_at <= $2::timestamptz
           AND (candidate.claimed_until IS NULL OR candidate.claimed_until <= $2::timestamptz)
           AND NOT EXISTS (
             SELECT 1 FROM oakridge.command_outbox earlier
             WHERE earlier.command_type = 'artifact_notification'
               AND earlier.target_workflow_id = candidate.target_workflow_id
               AND earlier.delivered_at IS NULL
               AND earlier.sequence_id < candidate.sequence_id
           )
         ORDER BY candidate.sequence_id
         FOR UPDATE SKIP LOCKED
         LIMIT $4
       )
       UPDATE oakridge.command_outbox notification
       SET claimed_by = $1, claimed_until = $3::timestamptz,
           attempt_count = notification.attempt_count + 1
       FROM candidates
       WHERE notification.id = candidates.id
       RETURNING notification.id::text, notification.target_workflow_id,
                 notification.payload AS message, notification.idempotency_key`,
      [workerId, claimedAt, claimedUntil, limit]);
  }

  async mark_notification_delivered(id: string, workerId: string, delivered_at: string): Promise<void> {
    await this.sql.query(
      `UPDATE oakridge.command_outbox SET delivered_at = $3::timestamptz, claimed_by = NULL,
         claimed_until = NULL, last_error = NULL
       WHERE id = $1::uuid AND command_type = 'artifact_notification'
         AND delivered_at IS NULL AND claimed_by = $2`, [id, workerId, delivered_at]);
  }

  async mark_notification_failed(id: string, workerId: string, error: string, nextAttemptAt: string): Promise<void> {
    await this.sql.query(
      `UPDATE oakridge.command_outbox SET claimed_by = NULL, claimed_until = NULL,
         last_error = $3, next_attempt_at = $4::timestamptz
       WHERE id = $1::uuid AND command_type = 'artifact_notification'
         AND delivered_at IS NULL AND claimed_by = $2`, [id, workerId, error, nextAttemptAt]);
  }

  private async enqueueNotification(transaction: SqlExecutor, targetWorkflowId: string, message: ArtifactLifecycleNotification, idempotencyKey: string, createdAt: string): Promise<void> {
    await transaction.query(
      `INSERT INTO oakridge.command_outbox
         (id, command_type, idempotency_key, target_workflow_id, payload, created_at)
       VALUES (md5($1)::uuid, 'artifact_notification', $1, $2, $3::jsonb, $4::timestamptz)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [idempotencyKey, targetWorkflowId, message, createdAt],
    );
  }

  private async recordEmissionKey(transaction: SqlExecutor, emission: ArtifactEmission, artifactId: ArtifactId, createdAt: string): Promise<void> {
    await transaction.query(
      `INSERT INTO oakridge.artifact_emission_idempotency
         (stage_instance_id, execution_id, unit_id, output_name, idempotency_key, payload_hash, artifact_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)`,
      [emission.stage_instance_id, emission.execution_id, emission.unit_id, emission.output_name,
        emission.idempotency_key, emission.payload_hash, artifactId, createdAt],
    );
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
         AND stage.ended_at IS NULL
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
      [request.execution_id, execution_workflow_id, request.stage_instance_id, request.unit_id, request.executor_type,
        JSON.stringify(parameters), JSON.stringify(request.inputs)],
    );
  }

  async attach_external(execution_id: ExecutionId, reference: ExternalExecutionReference): Promise<void> {
    await this.sql.query("UPDATE oakridge.executor_projection SET external_reference = $2::jsonb, updated_at = now() WHERE execution_id = $1", [execution_id, JSON.stringify(reference)]);
  }

  async record_terminal(execution_id: ExecutionId, observation: ExecutorTerminalObservation): Promise<void> {
    await this.sql.query("UPDATE oakridge.executor_projection SET terminal_observation = $2::jsonb, updated_at = now() WHERE execution_id = $1", [execution_id, JSON.stringify(observation)]);
  }

  async find_external(execution_id: ExecutionId): Promise<{ readonly executor_type: string; readonly external_reference: ExternalExecutionReference } | null> {
    const rows = await this.sql.query<{ readonly executor_type: string; readonly external_reference: ExternalExecutionReference | null }>(
      "SELECT executor_type, external_reference FROM oakridge.executor_projection WHERE execution_id = $1",
      [execution_id],
    );
    const row = rows[0];
    return row?.external_reference ? { executor_type: row.executor_type, external_reference: row.external_reference } : null;
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
              artifact.lifecycle_state, artifact.superseded_by_artifact_id::text,
              artifact.withdrawn_actor, artifact.withdrawn_reason,
              artifact.withdrawn_at::text, artifact.released_at::text,
              artifact.created_at::text, stage.stage_key
       FROM oakridge.artifact artifact
       JOIN oakridge.stage_instance stage ON stage.id = artifact.stage_instance_id
       WHERE artifact.run_id = $1 AND stage.stage_key = ANY($2::text[])
         AND artifact.lifecycle_state IN ('current', 'released')
       ORDER BY stage.stage_key, artifact.unit_id, artifact.output_name, artifact.created_at DESC, artifact.version DESC`,
      [run_id, stage_keys],
    );
    return rows.map((row) => ({ ...decodeArtifact(row), stage_key: row.stage_key }));
  }
}

export class PostgresCancellationTargetRepository implements CancellationTargetRepository {
  constructor(private readonly sql: TransactionalSqlExecutor) {}

  async list_for_attempt(root_workflow_id: string): Promise<readonly CancellationExecutionTarget[]> {
    const rows = await this.sql.query<{ readonly execution_id: string; readonly executor_type: string; readonly external_reference: ExternalExecutionReference | null }>(
      `SELECT projection.execution_id, projection.executor_type, projection.external_reference
       FROM oakridge.executor_projection projection
       JOIN oakridge.stage_instance stage ON stage.id = projection.stage_instance_id
       WHERE stage.attempt_root_workflow_id = $1`, [root_workflow_id]);
    return rows.map((row) => ({ execution_id: row.execution_id as ExecutionId, executor_type: row.executor_type, external_reference: row.external_reference }));
  }

  async terminalize_pending_waits(root_workflow_id: string, actor: string, reason: string, withdrawn_at: string): Promise<readonly CancellationWaitTarget[]> {
    return this.sql.transaction(async (transaction) => {
      const resources = await transaction.query<{ readonly resource_key: string }>(
        `SELECT DISTINCT concat(artifact.stage_instance_id, ':', artifact.execution_id, ':', artifact.unit_id, ':', artifact.output_name) AS resource_key
         FROM oakridge.artifact artifact
         JOIN oakridge.stage_instance stage ON stage.id = artifact.stage_instance_id
         WHERE stage.attempt_root_workflow_id = $1 AND artifact.lifecycle_state = 'current'`, [root_workflow_id]);
      for (const resource of resources) await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [resource.resource_key]);
      const waits = await transaction.query<{ readonly kind: "gate" | "handoff"; readonly workflow_id: string }>(
        `SELECT 'gate'::text AS kind, event.workflow_uuid AS workflow_id
         FROM dbos.workflow_events event
         JOIN oakridge.artifact artifact ON artifact.id = (COALESCE((event.value::jsonb)->'json', event.value::jsonb)->>'artifact_revision_id')::uuid
         JOIN oakridge.stage_instance stage ON stage.id = artifact.stage_instance_id
         WHERE event.key = 'gate-state' AND COALESCE((event.value::jsonb)->'json', event.value::jsonb)->>'status' = 'pending'
           AND artifact.lifecycle_state = 'current' AND stage.attempt_root_workflow_id = $1
         UNION ALL
         SELECT 'handoff'::text AS kind, event.workflow_uuid AS workflow_id
         FROM dbos.workflow_events event
         JOIN oakridge.artifact artifact ON artifact.id = (COALESCE((event.value::jsonb)->'json', event.value::jsonb)->>'artifact_id')::uuid
         JOIN oakridge.stage_instance stage ON stage.id = artifact.stage_instance_id
         WHERE event.key = 'handoff-state' AND COALESCE((event.value::jsonb)->'json', event.value::jsonb)->>'status' IN ('awaiting_downstream', 'awaiting_external')
           AND artifact.lifecycle_state = 'current' AND stage.attempt_root_workflow_id = $1`, [root_workflow_id]);
      const rows = await transaction.query<{ readonly id: string }>(
        `UPDATE oakridge.artifact artifact
       SET lifecycle_state = 'withdrawn', withdrawn_actor = $2, withdrawn_reason = $3,
           withdrawn_at = $4::timestamptz, lifecycle_updated_at = $4::timestamptz
       FROM oakridge.stage_instance stage
       WHERE artifact.stage_instance_id = stage.id
         AND stage.attempt_root_workflow_id = $1
         AND artifact.lifecycle_state = 'current'
       RETURNING artifact.id::text`,
        [root_workflow_id, actor, reason, withdrawn_at],
      );
      void rows;
      return waits.map((wait): CancellationWaitTarget => wait.kind === "gate"
        ? { kind: "gate", workflow_id: wait.workflow_id }
        : { kind: "handoff", workflow_id: wait.workflow_id });
    });
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
