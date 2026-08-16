import type { CollaborationMessage, CollaborationThread, CollaborationThreadWithMessages, MessageId, ReviewItem, ReviewItemId, ReviewItemStatus, ThreadId, ThreadStatus } from "../domain/collaboration";
import type { EpicWorkflowProfile, EpicWorkflowProfileId } from "../domain/epic";
import { confirmFinalPullRequest, observeFinalPullRequest, type FinalPullRequestDomainError, type FinalPullRequestReconciliation } from "../domain/final-pull-request";
import type { GateDecisionAudit, GateDecisionAuditId } from "../domain/gates";
import type { ArtifactId, ExecutionId, StageInstanceId, UnitId, WorkflowRunId } from "../domain/primitives";
import type { CollaborationRepository, EpicWorkflowProfileRepository, FinalPullRequestRepository, GateDecisionAuditRepository, PersistFinalPullRequestConfirmation, PersistFinalPullRequestObservation } from "./repositories";
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
      [profile.id, profile.workflow_run_id, profile.title, profile.slug, profile.lifecycle_state, profile.final_merge_policy, JSON.stringify(profile.repositories), profile.created_at, profile.updated_at],
    );
  }
  async find_by_id(id: EpicWorkflowProfileId): Promise<EpicWorkflowProfile | null> {
    const rows = await this.sql.query<EpicWorkflowProfile>("SELECT * FROM oakridge.epic_workflow_profile WHERE id = $1", [id]);
    return rows[0] ?? null;
  }
}

interface EpicProfileRow extends Omit<EpicWorkflowProfile, "id" | "workflow_run_id"> {
  readonly id: string;
  readonly workflow_run_id: string;
}

interface FinalPullRequestReconciliationRow extends Omit<FinalPullRequestReconciliation, "epic_profile_id"> {
  readonly epic_profile_id: string;
}

const decodeEpicProfile = (row: EpicProfileRow): EpicWorkflowProfile => ({
  ...row,
  id: row.id as EpicWorkflowProfileId,
  workflow_run_id: row.workflow_run_id as WorkflowRunId,
});

const decodeFinalPullRequestReconciliation = (row: FinalPullRequestReconciliationRow): FinalPullRequestReconciliation => ({
  ...row,
  epic_profile_id: row.epic_profile_id as EpicWorkflowProfileId,
});

const profileNotFound = (operation: FinalPullRequestDomainError["operation"], run_id: WorkflowRunId): FinalPullRequestDomainError => ({
  operation,
  kind: "profile_not_found",
  detail: `workflow run '${run_id}' has no Epic profile`,
});

export class PostgresFinalPullRequestRepository implements FinalPullRequestRepository {
  constructor(private readonly sql: TransactionalSqlExecutor) {}

  async observe(input: PersistFinalPullRequestObservation): Promise<ReturnType<typeof observeFinalPullRequest>> {
    return this.sql.transaction(async (transaction) => {
      const profile = await this.lockProfile(transaction, input.run_id);
      if (!profile) return { ok: false, error: profileNotFound("observe_final_pull_request", input.run_id) };
      const previous = await this.lockReconciliation(transaction, profile.id, input.repository_key);
      const isEligible = await this.isFinalIntegrationEligible(transaction, input.run_id);
      const result = observeFinalPullRequest({
        profile,
        repository_key: input.repository_key,
        observation: input.observation,
        previous,
        is_final_integration_eligible: isEligible,
        updated_at: input.updated_at,
      });
      if (!result.ok || result.value.outcome === "already_completed" || result.value.outcome === "ignored_stale") return result;
      const reconciliation = result.value.reconciliation;
      if (!reconciliation) throw new Error("final pull request observation produced no reconciliation");
      const written = await transaction.query<{ readonly epic_profile_id: string }>(
        `INSERT INTO oakridge.final_pull_request_reconciliation
           (epic_profile_id, repository_key, observation, mismatch, observed_at,
            merged_evidence_at, confirmation_idempotency_key, operator_comment, confirmed_at, updated_at)
         VALUES ($1,$2,$3::jsonb,$4::jsonb,$5::timestamptz,$6::timestamptz,$7,$8,$9::timestamptz,$10::timestamptz)
         ON CONFLICT (epic_profile_id, repository_key) DO UPDATE SET
           observation = EXCLUDED.observation, mismatch = EXCLUDED.mismatch,
           observed_at = EXCLUDED.observed_at,
           merged_evidence_at = COALESCE(EXCLUDED.merged_evidence_at, oakridge.final_pull_request_reconciliation.merged_evidence_at),
           updated_at = EXCLUDED.updated_at
         WHERE EXCLUDED.observed_at > oakridge.final_pull_request_reconciliation.observed_at
            OR (EXCLUDED.observed_at = oakridge.final_pull_request_reconciliation.observed_at
                AND EXCLUDED.observation = oakridge.final_pull_request_reconciliation.observation)
         RETURNING epic_profile_id::text`,
        [reconciliation.epic_profile_id, reconciliation.repository_key, reconciliation.observation,
          reconciliation.mismatch, reconciliation.observation.observed_at, reconciliation.merged_evidence_at,
          reconciliation.confirmation_idempotency_key, reconciliation.operator_comment,
          reconciliation.confirmed_at, reconciliation.updated_at],
      );
      if (!written[0]) return { ok: true, value: { outcome: "ignored_stale", profile, reconciliation: previous } };
      await this.updateProfile(transaction, result.value.profile);
      return result;
    });
  }

  async confirm(input: PersistFinalPullRequestConfirmation): Promise<ReturnType<typeof confirmFinalPullRequest>> {
    return this.sql.transaction(async (transaction) => {
      const profile = await this.lockProfile(transaction, input.run_id);
      if (!profile) return { ok: false, error: profileNotFound("confirm_final_pull_request", input.run_id) };
      const reused = await transaction.query<{ readonly repository_key: string }>(
        `SELECT repository_key FROM oakridge.final_pull_request_reconciliation
         WHERE epic_profile_id = $1 AND confirmation_idempotency_key = $2 FOR UPDATE`,
        [profile.id, input.request.idempotency_key],
      );
      if (reused[0] && reused[0].repository_key !== input.repository_key) {
        return { ok: false, error: { operation: "confirm_final_pull_request", kind: "idempotency_conflict", detail: "confirmation idempotency key was already used for another repository" } };
      }
      const previous = await this.lockReconciliation(transaction, profile.id, input.repository_key);
      if (previous?.confirmation_idempotency_key === input.request.idempotency_key && previous.confirmed_at !== null) {
        return { ok: true, value: { outcome: "already_completed", profile, reconciliation: previous } };
      }
      const isEligible = await this.isFinalIntegrationEligible(transaction, input.run_id);
      const result = confirmFinalPullRequest({
        profile,
        repository_key: input.repository_key,
        reconciliation: previous,
        request: input.request,
        is_final_integration_eligible: isEligible,
        confirmed_at: input.confirmed_at,
      });
      if (!result.ok) return result;
      const reconciliation = result.value.reconciliation;
      if (!reconciliation) throw new Error("final pull request confirmation produced no reconciliation");
      const updated = await transaction.query<{ readonly epic_profile_id: string }>(
        `UPDATE oakridge.final_pull_request_reconciliation
         SET confirmation_idempotency_key = $3,
             operator_comment = CASE WHEN confirmation_idempotency_key IS NULL THEN $4 ELSE operator_comment END,
             confirmed_at = COALESCE(confirmed_at, $5::timestamptz),
             updated_at = GREATEST(updated_at, $5::timestamptz)
         WHERE epic_profile_id = $1 AND repository_key = $2 AND merged_evidence_at IS NOT NULL
           AND (confirmation_idempotency_key IS NULL OR confirmation_idempotency_key = $3)
         RETURNING epic_profile_id::text`,
        [profile.id, input.repository_key, input.request.idempotency_key,
          input.request.operator_comment ?? null, input.confirmed_at],
      );
      if (!updated[0]) return { ok: false, error: { operation: "confirm_final_pull_request", kind: "idempotency_conflict", detail: "final pull request confirmation raced with newer durable state" } };
      await this.updateProfile(transaction, result.value.profile);
      return result;
    });
  }

  private async lockProfile(transaction: SqlExecutor, run_id: WorkflowRunId): Promise<EpicWorkflowProfile | null> {
    const rows = await transaction.query<EpicProfileRow>(
      `SELECT id::text, workflow_run_id::text, title, slug, lifecycle_state, final_merge_policy,
              repositories, created_at::text, updated_at::text
       FROM oakridge.epic_workflow_profile WHERE workflow_run_id = $1 FOR UPDATE`, [run_id]);
    return rows[0] ? decodeEpicProfile(rows[0]) : null;
  }

  private async lockReconciliation(transaction: SqlExecutor, profile_id: EpicWorkflowProfileId, repository_key: string): Promise<FinalPullRequestReconciliation | null> {
    const rows = await transaction.query<FinalPullRequestReconciliationRow>(
      `SELECT epic_profile_id::text, repository_key, observation, mismatch,
              merged_evidence_at::text, confirmation_idempotency_key, operator_comment,
              confirmed_at::text, updated_at::text
       FROM oakridge.final_pull_request_reconciliation
       WHERE epic_profile_id = $1 AND repository_key = $2 FOR UPDATE`, [profile_id, repository_key]);
    return rows[0] ? decodeFinalPullRequestReconciliation(rows[0]) : null;
  }

  private async isFinalIntegrationEligible(transaction: SqlExecutor, run_id: WorkflowRunId): Promise<boolean> {
    const rows = await transaction.query<{ readonly stage_key: string; readonly operator_role: "build" | "assessment"; readonly ended_at: string | null; readonly outcome: { readonly kind?: string } | null }>(
      `WITH current_attempt AS (
         SELECT root_workflow_id FROM oakridge.workflow_attempt
         WHERE run_id = $1 ORDER BY created_at DESC, root_workflow_id DESC LIMIT 1
       ), required_stage AS (
         SELECT entry.key AS stage_key, entry.value->>'operator_role' AS operator_role
         FROM oakridge.workflow_run run
         JOIN oakridge.workflow_definition definition ON definition.id = run.workflow_definition_id
         CROSS JOIN LATERAL jsonb_each(definition.definition->'graph'->'stages') entry
         WHERE run.id = $1 AND entry.value->>'operator_role' IN ('build', 'assessment')
       )
       SELECT required.stage_key, required.operator_role,
              stage.ended_at::text, stage.outcome
       FROM required_stage required
       CROSS JOIN current_attempt attempt
       LEFT JOIN oakridge.stage_instance stage
         ON stage.run_id = $1 AND stage.stage_key = required.stage_key
        AND stage.attempt_root_workflow_id = attempt.root_workflow_id`, [run_id]);
    const roles = new Set(rows.map((row) => row.operator_role));
    return roles.has("build") && roles.has("assessment")
      && rows.every((row) => row.ended_at !== null && row.outcome?.kind === "succeeded");
  }

  private async updateProfile(transaction: SqlExecutor, profile: EpicWorkflowProfile): Promise<void> {
    await transaction.query(
      `UPDATE oakridge.epic_workflow_profile
       SET lifecycle_state = $2, repositories = $3::jsonb, updated_at = $4::timestamptz
       WHERE id = $1`,
      [profile.id, profile.lifecycle_state, JSON.stringify(profile.repositories), profile.updated_at]);
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
