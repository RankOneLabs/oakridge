import type { ArtifactId, StageInstanceId, WorkflowRunId } from "../domain/primitives";
import type { ArtifactCoordinate, ArtifactRevision } from "../domain/artifacts";
import type { StageInstance, StageOutcome } from "../domain/workflow";
import type {
  ArtifactRevisionRepository,
  StageInstanceRepository,
  WorkflowRunRepository,
  WorkflowRunRecord,
} from "./repositories";
import { err, ok, type JsonValue } from "../domain/primitives";
import type { SqlExecutor, TransactionalSqlExecutor } from "./sql-executor";
import { effectiveArtifactPredicate } from "./sql-fragments";
import type { CreateWorkflowRunResult, PersistWorkflowRunLaunch, SetRunArchiveResult, UnstartedRun, WorkflowRunLaunchRecord, WorkflowRunListFilter } from "../domain/runs";
import type { EpicWorkflowProfile } from "../domain/epic";
import { isRunContext } from "../domain/run-context";
import { runRecordWorkflowId } from "../domain/workflow-ids";

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
    run.project_id::text, run.context, run.archived, run.created_at::text`;

  private decodeLaunch(row: {
    readonly id: string; readonly workflow_definition_id: string; readonly project_id: string | null;
    readonly context: JsonValue; readonly archived: boolean; readonly created_at: string;
  }): WorkflowRunLaunchRecord {
    return { id: row.id as WorkflowRunId, workflow_definition_id: row.workflow_definition_id as WorkflowRunLaunchRecord["workflow_definition_id"],
      project_id: row.project_id as WorkflowRunLaunchRecord["project_id"],
      // `context jsonb NOT NULL` admits a scalar; every write path produces an
      // object. A row that is not one carries nothing, and says so at the first
      // binding that reads it — the same refusal a launch missing that key gets.
      context: isRunContext(row.context) ? row.context : {},
      root_workflow_id: runRecordWorkflowId(row.id as WorkflowRunId), archived: row.archived, created_at: row.created_at };
  }

  async create_run(input: PersistWorkflowRunLaunch): Promise<CreateWorkflowRunResult> {
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
        readonly archived: boolean; readonly created_at: string;
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
                AND run.context = $4::jsonb AS immutable_matches
         FROM oakridge.workflow_run run
         WHERE run.id = $1`,
        [input.run.id, input.run.workflow_definition_id, input.run.project_id, input.run.context],
      );
      const existing = existingRows[0];
      if (existing) {
        if (!existing.immutable_matches || !await this.profileMatches(transaction, input)) {
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
      return ok({ kind: "created", run: { ...input.run, root_workflow_id: runRecordWorkflowId(input.run.id) }, epic_profile: input.epic_profile });
    });
  }

  async find_launch_by_id(id: WorkflowRunId): Promise<WorkflowRunLaunchRecord | null> {
    const rows = await this.sql.query<Parameters<PostgresWorkflowRunRepository["decodeLaunch"]>[0]>(
      `SELECT ${this.launchColumns} FROM oakridge.workflow_run run
       WHERE run.id = $1`, [id]);
    return rows[0] ? this.decodeLaunch(rows[0]) : null;
  }

  async list(filter: WorkflowRunListFilter = { archived: false }): Promise<readonly WorkflowRunLaunchRecord[]> {
    const rows = await this.sql.query<Parameters<PostgresWorkflowRunRepository["decodeLaunch"]>[0]>(
      `SELECT ${this.launchColumns} FROM oakridge.workflow_run run
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

  /**
   * An `active` run with no `dbos.workflow_status` row for its derived root
   * workflow id has not started yet — the durable signal the launch outbox
   * used to carry with a table (spec §2.5(4)). `'v2-run:'` is spelled as a SQL
   * literal here because a query cannot call `runRecordWorkflowId`; it is the
   * one other place outside that function this prefix is written.
   */
  async list_unstarted_runs(limit: number): Promise<readonly UnstartedRun[]> {
    const rows = await this.sql.query<{ readonly id: string }>(
      `SELECT run.id::text FROM oakridge.workflow_run run
       LEFT JOIN dbos.workflow_status status ON status.workflow_uuid = 'v2-run:' || run.id::text
       WHERE run.state = 'active' AND status.workflow_uuid IS NULL
       ORDER BY run.created_at, run.id LIMIT $1`, [limit]);
    return rows.map((row) => ({ run_id: row.id as WorkflowRunId, workflow_id: runRecordWorkflowId(row.id as WorkflowRunId) }));
  }

  private async findProfile(transaction: SqlExecutor, runId: WorkflowRunId): Promise<EpicWorkflowProfile | null> {
    const rows = await transaction.query<EpicWorkflowProfile>(
      `SELECT id::text, workflow_run_id::text, title, slug, lifecycle_state, final_merge_policy,
              base_branch, repositories, created_at::text, updated_at::text
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
              AND final_merge_policy = $6 AND base_branch = $7 AND repositories = $8::jsonb AS matches
       FROM oakridge.epic_workflow_profile WHERE workflow_run_id = $1`,
      [input.run.id, profile.id, profile.title, profile.slug, profile.lifecycle_state, profile.final_merge_policy,
        profile.base_branch, JSON.stringify(profile.repositories)]);
    return rows[0]?.matches === true;
  }

  private async insertProfile(transaction: SqlExecutor, profile: EpicWorkflowProfile): Promise<void> {
    await transaction.query(
      `INSERT INTO oakridge.epic_workflow_profile
         (id, workflow_run_id, title, slug, lifecycle_state, final_merge_policy, base_branch, repositories, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::timestamptz,$10::timestamptz)`,
      [profile.id, profile.workflow_run_id, profile.title, profile.slug, profile.lifecycle_state,
        profile.final_merge_policy, profile.base_branch, JSON.stringify(profile.repositories), profile.created_at, profile.updated_at]);
  }

  async find_by_id(id: WorkflowRunId): Promise<WorkflowRunRecord | null> {
    const rows = await this.sql.query<{ readonly id: string; readonly workflow_definition_id: string; readonly context: JsonValue; readonly archived: boolean }>(
      `SELECT id::text, workflow_definition_id::text, context, archived
       FROM oakridge.workflow_run WHERE id = $1`, [id]);
    const row = rows[0];
    return row ? { id: row.id as WorkflowRunId, workflow_definition_id: row.workflow_definition_id as WorkflowRunRecord["workflow_definition_id"], context: row.context, archived: row.archived } : null;
  }
}

/**
 * The read model over `stage_instance` domain-reads and artifact-detail use.
 * v1 also wrote and closed rows here through `start`/`finish`; both had no
 * `src/` caller left once the legacy execution stack that called them was
 * deleted (spec §2.5(3): the table is shared, but `find_by_id` is the only
 * v2 read of it).
 */
export class PostgresStageInstanceRepository implements StageInstanceRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async find_by_id(id: StageInstanceId): Promise<StageInstance | null> {
    const rows = await this.sql.query<StageRow>(
      "SELECT id, run_id, stage_key, stage_type, started_at::text, ended_at::text, outcome FROM oakridge.stage_instance WHERE id = $1",
      [id],
    );
    return rows[0] ? decodeStage(rows[0]) : null;
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
  readonly collection_key: string | null;
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
  /** The execution attempt that emitted this revision; null on rows from before it was recorded. */
  readonly attempt_workflow_id: string | null;
}

// `chain_id` is a stored column: it is fixed when a revision is inserted, and
// recomputing it per row meant a recursive CTE on every artifact read — four of
// them inside emit_revision's lock-holding transaction.
const artifactColumns = `id, chain_id,
  run_id, stage_instance_id, execution_id, unit_id, output_name, artifact_type,
  collection_key, label, body, version, parent_artifact_id, emission_payload_hash, lifecycle_state,
  superseded_by_artifact_id, withdrawn_actor, withdrawn_reason,
  withdrawn_at::text, released_at::text, created_at::text, attempt_workflow_id`;

/** Bind order for the complete slot coordinate, in one place so it cannot drift. */
const artifactCoordinateParameters = (coordinate: ArtifactCoordinate): readonly unknown[] =>
  [coordinate.stage_instance_id, coordinate.execution_id, coordinate.unit_id, coordinate.output_name, coordinate.collection_key ?? null];

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
  collection_key: row.collection_key as ArtifactRevision["collection_key"],
  version: row.version, parent_artifact_id: row.parent_artifact_id as ArtifactRevision["parent_artifact_id"],
  lifecycle: decodeArtifactLifecycle(row), created_at: row.created_at,
});

export class PostgresArtifactRevisionRepository implements ArtifactRevisionRepository {
  constructor(private readonly sql: TransactionalSqlExecutor) {}

  async find_current(coordinate: ArtifactCoordinate): Promise<ArtifactRevision | null> {
    const rows = await this.sql.query<ArtifactRow>(`SELECT ${artifactColumns} FROM oakridge.artifact artifact WHERE stage_instance_id = $1 AND execution_id = $2 AND unit_id = $3 AND output_name = $4 AND collection_key IS NOT DISTINCT FROM $5 AND lifecycle_state = 'current'`, artifactCoordinateParameters(coordinate));
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
       WHERE run_id = $1 AND ${effectiveArtifactPredicate("artifact")}
       ORDER BY created_at, version`, [run_id]);
    return rows.map(decodeArtifact);
  }
}
