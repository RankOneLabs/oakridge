/**
 * The v15 read/write boundaries that are not the run record itself: runs,
 * stage instances, artifact revisions, gate decisions, artifact threads, and
 * the final pull request's target.
 *
 * No status is written here. `oakridge.workflow_run`, `stage_instance` and
 * `cohort` status is `PostgresRunRecordWriter`'s alone — `archived` is the one
 * column on a run this module touches, because archiving is an operator
 * display choice and carries no owner version.
 */
import type { ArtifactCoordinate, ArtifactRevision, ArtifactRevisionLifecycle } from "../domain/artifacts";
import type { CollaborationMessage, CollaborationThread, CollaborationThreadWithMessages, MessageId, ThreadId, ThreadStatus } from "../domain/collaboration";
import { parseRunContextRepository } from "../domain/repository-refs";
import { selectBuiltInGateDisposition } from "../domain/gates";
import type { JsonValue } from "../domain/primitives";
import { err, ok, type ArtifactId, type AttemptId, type CohortId, type OutputCollectionKey, type ProjectId, type SessionId, type StageInstanceId, type UnitId, type WaitId, type WorkflowDefinitionId, type WorkflowRunId } from "../domain/primitives";
import type { BlockedReason, CoreStatus, NextActor, WorkflowRunRecord } from "../domain/records";
import { runRecordWorkflowId } from "../domain/workflow-ids";
import type { CreateWorkflowRunResult, PersistWorkflowRunLaunch, SetRunArchiveResult, UnstartedRun, WorkflowRunLaunchRecord, WorkflowRunListFilter } from "../domain/runs";
import type { RunContext } from "../domain/run-context";
import type { GateDecisionRecord } from "../domain/run-record";
import type { StageInstance, StageInstanceLifecycle, StageOutcome, WorkflowRunBundlePin } from "../domain/workflow";
import type {
  ArtifactRevisionRepository,
  CollaborationRepository,
  ForgeRepositoryRepository,
  GateDecisionReadRepository,
  RunArtifactReadRepository,
  StageInstanceRepository,
  WorkflowRunRepository,
} from "./repositories";
import type { SqlExecutor, TransactionalSqlExecutor } from "./sql-executor";

/* ------------------------------------------------------------------ *
 * Workflow runs
 * ------------------------------------------------------------------ */

interface RunRow {
  readonly id: string;
  readonly workflow_definition_id: string;
  readonly project_id: string | null;
  readonly context: JsonValue;
  readonly bundle_pin: WorkflowRunBundlePin;
  readonly status: CoreStatus;
  readonly blocked_reason: BlockedReason | null;
  readonly next_actor: NextActor | null;
  readonly outcome: JsonValue | null;
  readonly record_version: string;
  readonly archived: boolean;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly ended_at: string | null;
}

const RUN_COLUMNS = `id::text,workflow_definition_id::text,project_id::text,context,bundle_pin,status,blocked_reason,
  next_actor,outcome,record_version::text,archived,created_at::text,started_at::text,ended_at::text`;

const runRecord = (row: RunRow): WorkflowRunRecord => ({
  id: row.id as WorkflowRunId,
  workflow_definition_id: row.workflow_definition_id as WorkflowDefinitionId,
  project_id: row.project_id as ProjectId | null,
  context: row.context,
  bundle_pin: row.bundle_pin,
  status: row.status,
  blocked_reason: row.blocked_reason,
  next_actor: row.next_actor,
  outcome: row.outcome,
  record_version: Number(row.record_version) as WorkflowRunRecord["record_version"],
  archived: row.archived,
  created_at: row.created_at,
  started_at: row.started_at,
  ended_at: row.ended_at,
});

const launchRecord = (row: RunRow): WorkflowRunLaunchRecord => ({
  id: row.id as WorkflowRunId,
  workflow_definition_id: row.workflow_definition_id as WorkflowDefinitionId,
  project_id: row.project_id as ProjectId | null,
  context: (typeof row.context === "object" && row.context !== null && !Array.isArray(row.context) ? row.context : {}) as RunContext,
  bundle_pin: row.bundle_pin,
  root_workflow_id: runRecordWorkflowId(row.id as WorkflowRunId),
  archived: row.archived,
  created_at: row.created_at,
});

export class PostgresWorkflowRunRepository implements WorkflowRunRepository {
  constructor(private readonly sql: TransactionalSqlExecutor) {}

  async find_by_id(id: WorkflowRunId): Promise<WorkflowRunRecord | null> {
    const rows = await this.sql.query<RunRow>(`SELECT ${RUN_COLUMNS} FROM oakridge.workflow_run WHERE id=$1`, [id]);
    return rows[0] ? runRecord(rows[0]) : null;
  }

  async find_launch_by_id(id: WorkflowRunId): Promise<WorkflowRunLaunchRecord | null> {
    const rows = await this.sql.query<RunRow>(`SELECT ${RUN_COLUMNS} FROM oakridge.workflow_run WHERE id=$1`, [id]);
    return rows[0] ? launchRecord(rows[0]) : null;
  }

  /**
   * The run row is the launch's durable intent. Idempotent on the run id — a
   * launch keyed on an `Idempotency-Key` mints a deterministic id, so a retried
   * request must find its own run rather than conflict with it. A stored run
   * under the same id but a different definition is the caller reusing a key
   * for different work, which is the one case that conflicts.
   */
  async create_run(input: PersistWorkflowRunLaunch): Promise<CreateWorkflowRunResult> {
    return this.sql.transaction(async (tx) => {
      const definitions = await tx.query<{ readonly archived: boolean }>(
        "SELECT archived FROM oakridge.workflow_definition WHERE id=$1", [input.run.workflow_definition_id]);
      if (!definitions[0]) {
        return err({ operation: "create_workflow_run" as const, kind: "definition_not_found" as const,
          detail: `workflow definition '${input.run.workflow_definition_id}' was not found` });
      }
      if (input.run.project_id !== null) {
        const projects = await tx.query<{ readonly id: string }>("SELECT id::text FROM oakridge.project WHERE id=$1", [input.run.project_id]);
        if (!projects[0]) {
          return err({ operation: "create_workflow_run" as const, kind: "project_not_found" as const,
            detail: `project '${input.run.project_id}' was not found` });
        }
      }
      const inserted = await tx.query<{ readonly id: string }>(
        `INSERT INTO oakridge.workflow_run (id,workflow_definition_id,project_id,context,bundle_pin,archived,created_at)
         VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7::timestamptz)
         ON CONFLICT (id) DO NOTHING RETURNING id::text`,
        [input.run.id, input.run.workflow_definition_id, input.run.project_id, JSON.stringify(input.run.context),
          JSON.stringify(input.run.bundle_pin), input.run.archived, input.run.created_at]);
      const stored = await tx.query<RunRow>(`SELECT ${RUN_COLUMNS} FROM oakridge.workflow_run WHERE id=$1`, [input.run.id]);
      const row = stored[0];
      if (!row) throw new Error(`workflow run '${input.run.id}' was not persisted`);
      if (row.workflow_definition_id !== input.run.workflow_definition_id) {
        return err({ operation: "create_workflow_run" as const, kind: "idempotency_conflict" as const,
          detail: `run '${input.run.id}' already exists for a different workflow definition` });
      }
      return ok({ kind: inserted.length > 0 ? "created" as const : "replayed" as const, run: launchRecord(row) });
    });
  }

  async list(filter?: WorkflowRunListFilter): Promise<readonly WorkflowRunLaunchRecord[]> {
    const rows = await this.sql.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM oakridge.workflow_run
       WHERE ($1::boolean IS NULL OR archived=$1::boolean)
         AND ($2::uuid IS NULL OR workflow_definition_id=$2::uuid)
         AND ($3::uuid IS NULL OR project_id=$3::uuid)
       ORDER BY created_at DESC,id`,
      [filter?.archived ?? null, filter?.workflow_definition_id ?? null, filter?.project_id ?? null]);
    return rows.map(launchRecord);
  }

  async set_archived(id: WorkflowRunId, archived: boolean): Promise<SetRunArchiveResult> {
    const rows = await this.sql.query<{ readonly archived: boolean; readonly changed: boolean }>(
      `UPDATE oakridge.workflow_run SET archived=$2 WHERE id=$1 RETURNING archived,(archived IS DISTINCT FROM $2) AS changed`,
      [id, archived]);
    const row = rows[0];
    if (!row) return { kind: "not_found", run_id: id };
    return { kind: "updated", run_id: id, archived: row.archived };
  }

  /**
   * A run whose durable intent is stored but whose root workflow has no DBOS
   * row. `'v15-run:'` is spelled as a SQL literal here and in
   * `list_application_versions` — the two places outside `runMachineWorkflowId`
   * this prefix is written.
   */
  async list_unstarted_runs(limit: number): Promise<readonly UnstartedRun[]> {
    const rows = await this.sql.query<{ readonly run_id: string; readonly workflow_id: string }>(
      `SELECT run.id::text AS run_id,'v15-run:' || run.id::text AS workflow_id
       FROM oakridge.workflow_run run
       WHERE run.status IN ('pending','active','blocked') AND run.archived=false
         AND NOT EXISTS (SELECT 1 FROM dbos.workflow_status status WHERE status.workflow_uuid='v15-run:' || run.id::text)
       ORDER BY run.created_at,run.id LIMIT $1`, [limit]);
    return rows.map((row) => ({ run_id: row.run_id as WorkflowRunId, workflow_id: row.workflow_id as UnstartedRun["workflow_id"] }));
  }
}

/* ------------------------------------------------------------------ *
 * Stage instances
 * ------------------------------------------------------------------ */

interface StageRow {
  readonly id: string;
  readonly run_id: string;
  readonly stage_key: string;
  readonly stage_type: string;
  readonly stage_contract: JsonValue;
  readonly status: CoreStatus;
  readonly outcome: StageOutcome | null;
  readonly started_at: string | null;
  readonly ended_at: string | null;
}

const stageLifecycle = (row: StageRow): StageInstanceLifecycle => {
  if (row.ended_at !== null) {
    return { kind: "finished", started_at: row.started_at ?? row.ended_at, ended_at: row.ended_at,
      outcome: row.outcome ?? { kind: row.status === "cancelled" ? "cancelled" : "failed", ...(row.status === "cancelled" ? { reason: null } : { code: row.status, detail: "" }) } as StageOutcome };
  }
  return row.started_at === null ? { kind: "pending" } : { kind: "started", started_at: row.started_at };
};

export class PostgresStageInstanceRepository implements StageInstanceRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async find_by_id(id: StageInstanceId): Promise<StageInstance | null> {
    const rows = await this.sql.query<StageRow>(
      `SELECT id::text,run_id::text,stage_key,stage_type,stage_contract,status,outcome,started_at::text,ended_at::text
       FROM oakridge.stage_instance WHERE id=$1`, [id]);
    const row = rows[0];
    if (!row) return null;
    return { id: row.id as StageInstanceId, run_id: row.run_id as WorkflowRunId, stage_key: row.stage_key,
      stage_type: row.stage_type, lifecycle: stageLifecycle(row) };
  }

  async find_contract(id: StageInstanceId): Promise<{ readonly run_id: WorkflowRunId; readonly stage_key: string; readonly stage_contract: JsonValue } | null> {
    const rows = await this.sql.query<{ readonly run_id: string; readonly stage_key: string; readonly stage_contract: JsonValue }>(
      "SELECT run_id::text,stage_key,stage_contract FROM oakridge.stage_instance WHERE id=$1", [id]);
    const row = rows[0];
    return row ? { run_id: row.run_id as WorkflowRunId, stage_key: row.stage_key, stage_contract: row.stage_contract } : null;
  }
}

/* ------------------------------------------------------------------ *
 * Artifact revisions
 * ------------------------------------------------------------------ */

interface ArtifactRevisionRow {
  readonly id: string;
  readonly chain_id: string;
  readonly revision: number;
  readonly parent_artifact_id: string | null;
  readonly artifact_type: string;
  readonly body: JsonValue;
  readonly label: string | null;
  readonly lifecycle: "current" | "superseded" | "withdrawn" | "released";
  readonly created_at: string;
  readonly superseded_by_artifact_id: string | null;
  readonly run_id: string;
  readonly cohort_id: string | null;
  readonly stage_instance_id: string;
  readonly unit_id: string | null;
  readonly output_name: string | null;
  readonly collection_key: string | null;
  readonly attempt_id: string | null;
  readonly session_id: string | null;
}

/**
 * One revision, from the four tables v15 splits an artifact across.
 *
 * Output identity comes from `artifact_acceptance` after acceptance and from
 * `cohort_output` while the revision is awaiting a gate decision.
 */
const ARTIFACT_REVISION_SOURCE = `
  FROM oakridge.artifact artifact
  JOIN oakridge.artifact_owner owner ON owner.artifact_id=artifact.id
  LEFT JOIN oakridge.artifact_acceptance acceptance ON acceptance.artifact_id=artifact.id
  LEFT JOIN oakridge.artifact_provenance provenance ON provenance.artifact_id=artifact.id
  LEFT JOIN oakridge.cohort cohort ON cohort.id=owner.cohort_id
  LEFT JOIN oakridge.artifact superseded ON superseded.parent_artifact_id=artifact.id
  LEFT JOIN oakridge.cohort_output pending_slot ON pending_slot.artifact_id=artifact.id`;

const ARTIFACT_REVISION_COLUMNS = `
  artifact.id::text,artifact.chain_id::text,artifact.revision,artifact.parent_artifact_id::text,
  artifact.artifact_type,artifact.body,artifact.label,artifact.lifecycle,artifact.created_at::text,
  superseded.id::text AS superseded_by_artifact_id,
  owner.run_id::text,owner.cohort_id::text,
  COALESCE(acceptance.receiving_stage_instance_id,
           owner.stage_instance_id,provenance.stage_instance_id)::text AS stage_instance_id,
  cohort.cohort_key AS unit_id,
  COALESCE(acceptance.output_name,pending_slot.output_name) AS output_name,
  COALESCE(acceptance.collection_key,pending_slot.collection_key) AS collection_key,
  provenance.attempt_id::text,provenance.session_id::text`;

/** Every artifact oakridge writes is either accepted into a slot or parked in one. */
const ARTIFACT_HAS_SLOT = `COALESCE(acceptance.receiving_stage_instance_id,
  owner.stage_instance_id,provenance.stage_instance_id) IS NOT NULL`;

const revisionLifecycle = (row: ArtifactRevisionRow): ArtifactRevisionLifecycle => {
  if (row.lifecycle === "superseded") return { kind: "superseded", superseded_by_artifact_id: row.superseded_by_artifact_id as ArtifactId | null };
  if (row.lifecycle === "withdrawn") return { kind: "withdrawn" };
  if (row.lifecycle === "released") return { kind: "released" };
  return { kind: "current" };
};

const artifactRevision = (row: ArtifactRevisionRow): ArtifactRevision => ({
  id: row.id as ArtifactId,
  chain_id: row.chain_id as ArtifactId,
  run_id: row.run_id as WorkflowRunId,
  stage_instance_id: row.stage_instance_id as StageInstanceId,
  cohort_id: row.cohort_id as CohortId | null,
  unit_id: row.unit_id as UnitId | null,
  attempt_id: row.attempt_id as AttemptId | null,
  session_id: row.session_id as SessionId | null,
  output_name: row.output_name,
  collection_key: row.collection_key as OutputCollectionKey | null,
  artifact_type: row.artifact_type,
  label: row.label,
  body: row.body,
  version: row.revision,
  parent_artifact_id: row.parent_artifact_id as ArtifactId | null,
  lifecycle: revisionLifecycle(row),
  created_at: row.created_at,
});

export class PostgresArtifactRepository implements ArtifactRevisionRepository, RunArtifactReadRepository, GateDecisionReadRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async find_by_id(id: ArtifactId): Promise<ArtifactRevision | null> {
    const rows = await this.sql.query<ArtifactRevisionRow>(
      `SELECT ${ARTIFACT_REVISION_COLUMNS} ${ARTIFACT_REVISION_SOURCE} WHERE artifact.id=$1 AND ${ARTIFACT_HAS_SLOT}`, [id]);
    return rows[0] ? artifactRevision(rows[0]) : null;
  }

  async list_chain(chain_id: ArtifactId): Promise<readonly ArtifactRevision[]> {
    const rows = await this.sql.query<ArtifactRevisionRow>(
      `SELECT ${ARTIFACT_REVISION_COLUMNS} ${ARTIFACT_REVISION_SOURCE}
       WHERE artifact.chain_id=$1 AND ${ARTIFACT_HAS_SLOT} ORDER BY artifact.revision`, [chain_id]);
    return rows.map(artifactRevision);
  }

  /**
   * The revision currently holding a declared slot — accepted, or parked pending
   * its gate.
   *
   * Scoped to the stage instance, so on a fan-out stage it answers with whichever
   * cohort's revision sorts first. That is only sound for a scalar stage, and this
   * has no production caller: `publish_artifact` resolves the slot itself, per
   * cohort. A caller that needs it for a fan-out stage has to take the cohort as
   * part of the coordinate.
   */
  async find_current(coordinate: ArtifactCoordinate): Promise<ArtifactRevision | null> {
    const rows = await this.sql.query<ArtifactRevisionRow>(
      `SELECT ${ARTIFACT_REVISION_COLUMNS} ${ARTIFACT_REVISION_SOURCE}
       WHERE ${ARTIFACT_HAS_SLOT}
         AND COALESCE(acceptance.receiving_stage_instance_id,pending_slot.receiving_stage_instance_id)=$1
         AND COALESCE(acceptance.output_name,pending_slot.output_name)=$2
         AND COALESCE(acceptance.collection_key,pending_slot.collection_key) IS NOT DISTINCT FROM $3
         AND artifact.lifecycle IN ('current','released')
       ORDER BY artifact.revision DESC LIMIT 1`,
      [coordinate.stage_instance_id, coordinate.output_name, coordinate.collection_key ?? null]);
    return rows[0] ? artifactRevision(rows[0]) : null;
  }

  /**
   * Every revision the run holds that a surface should show. Deliberately
   * broader than "released": an artifact parked pending its gate is exactly
   * what the operator is being asked to look at.
   */
  async list_effective_for_run(run_id: WorkflowRunId): Promise<readonly ArtifactRevision[]> {
    const rows = await this.sql.query<ArtifactRevisionRow>(
      `SELECT ${ARTIFACT_REVISION_COLUMNS} ${ARTIFACT_REVISION_SOURCE}
       WHERE owner.run_id=$1 AND ${ARTIFACT_HAS_SLOT} AND artifact.lifecycle IN ('current','released')
       ORDER BY artifact.created_at,artifact.id`, [run_id]);
    return rows.map(artifactRevision);
  }

  /**
   * A downstream stage's inputs: the revisions accepted into one stage's
   * declared output. Acceptance is the release fact in v15 — a gated artifact
   * has no acceptance row until its gate lets it through — so this needs no
   * second wait predicate.
   */
  async list_released_for_stage_output(stage_instance_id: StageInstanceId, output_name: string): Promise<readonly ArtifactRevision[]> {
    const rows = await this.sql.query<ArtifactRevisionRow>(
      `SELECT ${ARTIFACT_REVISION_COLUMNS} ${ARTIFACT_REVISION_SOURCE}
       WHERE acceptance.receiving_stage_instance_id=$1 AND acceptance.output_name=$2
         AND artifact.lifecycle IN ('current','released')
       ORDER BY acceptance.collection_key NULLS FIRST,artifact.revision DESC`, [stage_instance_id, output_name]);
    return rows.map(artifactRevision);
  }

  /**
   * How a decided gate labelled one revision, read from the wait that decided
   * it. `wait_gate.outcome` is written by the decision itself, so there is no
   * separate audit row to fall out of step with it.
   */
  async find_for_revision(artifact_revision_id: ArtifactId): Promise<GateDecisionRecord | null> {
    const rows = await this.sql.query<{
      readonly wait_id: string; readonly gate_step: string | null; readonly action: string | null;
      readonly actor: string | null; readonly detail: string | null; readonly closed_at: string;
    }>(
      `SELECT wait.id::text AS wait_id,wait.closes_on->>'gate_step' AS gate_step,
              wait.outcome->>'action' AS action,wait.outcome->>'actor' AS actor,
              wait.outcome->>'detail' AS detail,wait.closed_at::text AS closed_at
       FROM oakridge.wait_gate wait
       JOIN oakridge.wait_gate_artifact_revision link ON link.wait_gate_id=wait.id
       WHERE link.artifact_id=$1 AND wait.kind='gate' AND wait.status='closed'
       ORDER BY wait.closed_at DESC,wait.id DESC LIMIT 1`, [artifact_revision_id]);
    const row = rows[0];
    if (!row || row.action === null) return null;
    return { wait_id: row.wait_id as WaitId, artifact_revision_id, gate_step: row.gate_step,
      action: row.action, actor: row.actor ?? "unknown", detail: row.detail, decided_at: row.closed_at };
  }
}

/** Whether an action's built-in disposition released the artifact it decided. */
export const isGateReleaseAction = (action: string): boolean => selectBuiltInGateDisposition(action) === "release";

/* ------------------------------------------------------------------ *
 * Artifact threads
 * ------------------------------------------------------------------ */

interface ThreadRow {
  readonly id: string;
  readonly chain_id: string;
  readonly artifact_id: string;
  readonly anchor: string | null;
  readonly status: ThreadStatus;
  readonly created_at: string;
}

interface ThreadMessageRow {
  readonly id: string;
  readonly thread_id: string;
  readonly body: string;
  readonly author: string;
  readonly created_at: string;
}

const thread = (row: ThreadRow): CollaborationThread => ({
  id: row.id as ThreadId, artifact_id: row.chain_id as ArtifactId, revision_id: row.artifact_id as ArtifactId,
  anchor: row.anchor, status: row.status, created_at: row.created_at,
});

const threadMessage = (row: ThreadMessageRow): CollaborationMessage => ({
  id: row.id as MessageId, thread_id: row.thread_id as ThreadId, body: row.body, author: row.author, created_at: row.created_at,
});

const insertThread = async (sql: SqlExecutor, value: CollaborationThread): Promise<ThreadId> => {
  await sql.query(
    `INSERT INTO oakridge.artifact_thread (id,chain_id,artifact_id,anchor,status,created_at)
     VALUES ($1,$2,$3,$4,$5,$6::timestamptz) ON CONFLICT (id) DO NOTHING`,
    [value.id, value.artifact_id, value.revision_id, value.anchor, value.status, value.created_at]);
  return value.id;
};

const insertThreadMessage = async (sql: SqlExecutor, value: CollaborationMessage): Promise<MessageId> => {
  await sql.query(
    `INSERT INTO oakridge.artifact_thread_message (id,thread_id,body,author,created_at)
     VALUES ($1,$2,$3,$4,$5::timestamptz) ON CONFLICT (id) DO NOTHING`,
    [value.id, value.thread_id, value.body, value.author, value.created_at]);
  return value.id;
};

export class PostgresCollaborationRepository implements CollaborationRepository {
  constructor(private readonly sql: TransactionalSqlExecutor) {}

  insert_thread(value: CollaborationThread): Promise<ThreadId> { return insertThread(this.sql, value); }
  insert_message(value: CollaborationMessage): Promise<MessageId> { return insertThreadMessage(this.sql, value); }

  async insert_thread_with_message(value: CollaborationThread, message: CollaborationMessage): Promise<{ readonly thread_id: ThreadId; readonly message_id: MessageId }> {
    return this.sql.transaction(async (tx) => {
      const thread_id = await insertThread(tx, value);
      const message_id = await insertThreadMessage(tx, message);
      return { thread_id, message_id };
    });
  }

  async find_thread(id: ThreadId): Promise<CollaborationThread | null> {
    const rows = await this.sql.query<ThreadRow>(
      "SELECT id::text,chain_id::text,artifact_id::text,anchor,status,created_at::text FROM oakridge.artifact_thread WHERE id=$1", [id]);
    return rows[0] ? thread(rows[0]) : null;
  }

  async list_threads(chain_id: ArtifactId): Promise<readonly CollaborationThreadWithMessages[]> {
    const threads = await this.sql.query<ThreadRow>(
      `SELECT id::text,chain_id::text,artifact_id::text,anchor,status,created_at::text
       FROM oakridge.artifact_thread WHERE chain_id=$1 ORDER BY created_at,id`, [chain_id]);
    if (threads.length === 0) return [];
    const messages = await this.sql.query<ThreadMessageRow>(
      `SELECT id::text,thread_id::text,body,author,created_at::text
       FROM oakridge.artifact_thread_message WHERE thread_id=ANY($1::uuid[]) ORDER BY created_at,id`,
      [threads.map((row) => row.id)]);
    return threads.map((row) => ({ ...thread(row),
      messages: messages.filter((message) => message.thread_id === row.id).map(threadMessage) }));
  }

  async update_thread_status(id: ThreadId, status: ThreadStatus): Promise<void> {
    await this.sql.query("UPDATE oakridge.artifact_thread SET status=$2,updated_at=clock_timestamp() WHERE id=$1", [id, status]);
  }
}

/* ------------------------------------------------------------------ *
 * Forge identity from the run context
 * ------------------------------------------------------------------ */

const readContextRepositories = (context: JsonValue): readonly JsonValue[] => {
  if (typeof context !== "object" || context === null || Array.isArray(context)) return [];
  const repositories = (context as { readonly repositories?: JsonValue }).repositories;
  return Array.isArray(repositories) ? repositories : [];
};

/**
 * The final epic pull request's target, assembled from the run context and the
 * adapter's own build cohort. The forge identity and merge policy used to come
 * from `epic_workflow_profile`; they are launch configuration, so they now
 * arrive on the run context that every other stage already reads.
 */
export class PostgresForgeRepositoryRepository implements ForgeRepositoryRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async find_forge_repository(run_id: WorkflowRunId, repository_key: string): Promise<{ readonly owner: string; readonly name: string } | null> {
    const rows = await this.sql.query<{ readonly context: JsonValue }>(
      "SELECT context FROM oakridge.workflow_run WHERE id=$1", [run_id]);
    const repository = readContextRepositories(rows[0]?.context ?? null)
      .map(parseRunContextRepository)
      .flatMap((parsed) => (parsed.ok ? [parsed.value] : []))
      .find((candidate) => candidate.key === repository_key);
    if (!repository?.forge_repository) return null;
    return { owner: repository.forge_repository.owner, name: repository.forge_repository.name };
  }
}
