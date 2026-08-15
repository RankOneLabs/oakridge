import type { CollaborationMessage, CollaborationThread, CollaborationThreadWithMessages, MessageId, ReviewItem, ReviewItemId, ReviewItemStatus, ThreadId, ThreadStatus } from "../domain/collaboration";
import type { EpicWorkflowProfile, EpicWorkflowProfileId } from "../domain/epic";
import type { GateDecisionAudit, GateDecisionAuditId } from "../domain/gates";
import type { ArtifactId, ExecutionId, StageInstanceId, UnitId, WorkflowRunId } from "../domain/primitives";
import type { CollaborationRepository, EpicWorkflowProfileRepository, GateDecisionAuditRepository } from "./repositories";
import type { SqlExecutor, TransactionalSqlExecutor } from "./sql-executor";

interface GateAuditRow {
  readonly id: string; readonly run_id: string; readonly stage_instance_id: string; readonly execution_id: string;
  readonly unit_id: string; readonly artifact_chain_id: string; readonly artifact_revision_id: string;
  readonly gate_step: string; readonly action: string; readonly operator_comment: string | null; readonly feedback: string | null;
  readonly idempotency_key: string; readonly created_at: string; readonly applied_at: string | null;
}

const decodeGateAudit = (row: GateAuditRow): GateDecisionAudit => ({
  id: row.id as GateDecisionAuditId,
  run_id: row.run_id as WorkflowRunId,
  stage_instance_id: row.stage_instance_id as StageInstanceId,
  execution_id: row.execution_id as ExecutionId,
  unit_id: row.unit_id as UnitId,
  artifact_chain_id: row.artifact_chain_id as ArtifactId,
  artifact_revision_id: row.artifact_revision_id as ArtifactId,
  gate_step: row.gate_step,
  action: row.action,
  operator_comment: row.operator_comment,
  feedback: row.feedback,
  idempotency_key: row.idempotency_key,
  created_at: row.created_at,
  applied_at: row.applied_at,
});

export class PostgresGateDecisionAuditRepository implements GateDecisionAuditRepository {
  constructor(private readonly sql: SqlExecutor) {}
  async insert_idempotent(audit: GateDecisionAudit): Promise<GateDecisionAuditId> {
    const rows = await this.sql.query<{ id: string }>(
      `INSERT INTO oakridge.gate_decision_audit
       (id, run_id, stage_instance_id, execution_id, unit_id, artifact_chain_id,
        artifact_revision_id, gate_step, action, operator_comment, feedback,
        idempotency_key, created_at, applied_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::timestamptz,$14::timestamptz)
       ON CONFLICT (idempotency_key) DO UPDATE SET id = oakridge.gate_decision_audit.id
       RETURNING id`,
      [audit.id, audit.run_id, audit.stage_instance_id, audit.execution_id, audit.unit_id, audit.artifact_chain_id, audit.artifact_revision_id, audit.gate_step, audit.action, audit.operator_comment, audit.feedback, audit.idempotency_key, audit.created_at, audit.applied_at],
    );
    if (!rows[0]) throw new Error("gate audit insert returned no identity");
    return rows[0].id as GateDecisionAuditId;
  }
  async mark_applied(id: GateDecisionAuditId, applied_at: string): Promise<void> {
    await this.sql.query("UPDATE oakridge.gate_decision_audit SET applied_at = COALESCE(applied_at, $2::timestamptz) WHERE id = $1", [id, applied_at]);
  }
  async find_by_idempotency_key(idempotency_key: string): Promise<GateDecisionAudit | null> {
    const rows = await this.sql.query<GateAuditRow>("SELECT id, run_id, stage_instance_id, execution_id, unit_id, artifact_chain_id, artifact_revision_id, gate_step, action, operator_comment, feedback, idempotency_key, created_at::text, applied_at::text FROM oakridge.gate_decision_audit WHERE idempotency_key = $1", [idempotency_key]);
    return rows[0] ? decodeGateAudit(rows[0]) : null;
  }
  async find_for_revision(artifact_revision_id: ArtifactId): Promise<GateDecisionAudit | null> {
    const rows = await this.sql.query<GateAuditRow>("SELECT id, run_id, stage_instance_id, execution_id, unit_id, artifact_chain_id, artifact_revision_id, gate_step, action, operator_comment, feedback, idempotency_key, created_at::text, applied_at::text FROM oakridge.gate_decision_audit WHERE artifact_revision_id = $1 AND applied_at IS NOT NULL ORDER BY applied_at DESC LIMIT 1", [artifact_revision_id]);
    return rows[0] ? decodeGateAudit(rows[0]) : null;
  }
}

export class PostgresEpicWorkflowProfileRepository implements EpicWorkflowProfileRepository {
  constructor(private readonly sql: SqlExecutor) {}
  async insert(profile: EpicWorkflowProfile): Promise<void> {
    await this.sql.query(
      `INSERT INTO oakridge.epic_workflow_profile
       (id, workflow_run_id, title, slug, lifecycle_state, final_merge_policy, repositories, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::timestamptz,$9::timestamptz)`,
      [profile.id, profile.workflow_run_id, profile.title, profile.slug, profile.lifecycle_state, profile.final_merge_policy, profile.repositories, profile.created_at, profile.updated_at],
    );
  }
  async find_by_id(id: EpicWorkflowProfileId): Promise<EpicWorkflowProfile | null> {
    const rows = await this.sql.query<EpicWorkflowProfile>("SELECT * FROM oakridge.epic_workflow_profile WHERE id = $1", [id]);
    return rows[0] ?? null;
  }
}

export class PostgresCollaborationRepository implements CollaborationRepository {
  constructor(private readonly sql: TransactionalSqlExecutor) {}
  async insert_thread_with_message(thread: CollaborationThread, message: CollaborationMessage): Promise<{ readonly thread_id: ThreadId; readonly message_id: MessageId }> {
    return this.sql.transaction(async (transaction) => {
      await transaction.query("INSERT INTO oakridge.collaboration_thread (id, artifact_id, revision_id, anchor, status, created_at) VALUES ($1,$2,$3,$4,$5,$6::timestamptz)", [thread.id, thread.artifact_id, thread.revision_id, thread.anchor, thread.status, thread.created_at]);
      await transaction.query("INSERT INTO oakridge.collaboration_message (id, thread_id, body, author, created_at) VALUES ($1,$2,$3,$4,$5::timestamptz)", [message.id, message.thread_id, message.body, message.author, message.created_at]);
      return { thread_id: thread.id, message_id: message.id };
    });
  }
  async insert_thread(value: CollaborationThread): Promise<ThreadId> {
    await this.sql.query("INSERT INTO oakridge.collaboration_thread (id, artifact_id, revision_id, anchor, status, created_at) VALUES ($1,$2,$3,$4,$5,$6::timestamptz)", [value.id, value.artifact_id, value.revision_id, value.anchor, value.status, value.created_at]);
    return value.id;
  }
  async insert_message(value: CollaborationMessage): Promise<MessageId> {
    await this.sql.query("INSERT INTO oakridge.collaboration_message (id, thread_id, body, author, created_at) VALUES ($1,$2,$3,$4,$5::timestamptz)", [value.id, value.thread_id, value.body, value.author, value.created_at]);
    return value.id;
  }
  async insert_review_item(value: ReviewItem): Promise<ReviewItemId> {
    await this.sql.query("INSERT INTO oakridge.review_item (id, artifact_id, revision_id, anchor, claim, reality, status, resolution, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz)", [value.id, value.artifact_id, value.revision_id, value.anchor, value.claim, value.reality, value.status, value.resolution, value.created_at]);
    return value.id;
  }
  async find_thread(id: ThreadId): Promise<CollaborationThread | null> {
    const rows = await this.sql.query<CollaborationThread>("SELECT id, artifact_id, revision_id, anchor, status, created_at::text FROM oakridge.collaboration_thread WHERE id = $1", [id]);
    return rows[0] ?? null;
  }
  async list_threads(chain_id: ArtifactId): Promise<readonly CollaborationThreadWithMessages[]> {
    const threads = await this.sql.query<CollaborationThread>("SELECT id, artifact_id, revision_id, anchor, status, created_at::text FROM oakridge.collaboration_thread WHERE artifact_id = $1 ORDER BY created_at", [chain_id]);
    const result: CollaborationThreadWithMessages[] = [];
    for (const thread of threads) {
      const messages = await this.sql.query<CollaborationMessage>("SELECT id, thread_id, body, author, created_at::text FROM oakridge.collaboration_message WHERE thread_id = $1 ORDER BY created_at", [thread.id]);
      result.push({ ...thread, messages });
    }
    return result;
  }
  async update_thread_status(id: ThreadId, status: ThreadStatus): Promise<void> {
    await this.sql.query("UPDATE oakridge.collaboration_thread SET status = $2 WHERE id = $1", [id, status]);
  }
  async find_review_item(id: ReviewItemId): Promise<ReviewItem | null> {
    const rows = await this.sql.query<ReviewItem>("SELECT id, artifact_id, revision_id, anchor, claim, reality, status, resolution, created_at::text FROM oakridge.review_item WHERE id = $1", [id]);
    return rows[0] ?? null;
  }
  async list_review_items(chain_id: ArtifactId): Promise<readonly ReviewItem[]> {
    return this.sql.query<ReviewItem>("SELECT id, artifact_id, revision_id, anchor, claim, reality, status, resolution, created_at::text FROM oakridge.review_item WHERE artifact_id = $1 ORDER BY created_at", [chain_id]);
  }
  async update_review_item(id: ReviewItemId, status: ReviewItemStatus, resolution: string | null): Promise<void> {
    await this.sql.query("UPDATE oakridge.review_item SET status = $2, resolution = $3 WHERE id = $1", [id, status, resolution]);
  }
  async count_open_review_items(revision_id: ReviewItem["revision_id"]): Promise<number> {
    const rows = await this.sql.query<{ count: string }>("SELECT count(*)::text AS count FROM oakridge.review_item WHERE revision_id = $1 AND status = 'open'", [revision_id]);
    return Number(rows[0]?.count ?? 0);
  }
}
