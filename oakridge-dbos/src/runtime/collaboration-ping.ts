import type { DBOSClient } from "@dbos-inc/dbos-sdk";

import { isTerminalSessionMessageDelivery, type DeliverSessionMessage, type SessionMessage, type SessionMessageDeliveryResult, type SessionMessageEnqueueResult, type SessionMessageRecipientResolution, type SessionMessageRecipientResolver, type SessionMessageRecord, type SessionMessageRepository, type SessionThreadId, type SessionThreadMessageId } from "../domain/collaboration";
import type { ExternalExecutionReference } from "../domain/execution";
import { parseUuidId, type CohortId, type DeliveryKey, type ExecutionId, type JsonValue, type SessionId, type SessionMessageId, type WorkflowRunId } from "../domain/primitives";
import type { SqlExecutor, TransactionalSqlExecutor } from "../storage/sql-executor";
import { registerSessionMessageRepository } from "../workflows/collaboration-responder";

export interface CollaborationPingClient {
  enqueue(input: DeliverSessionMessage): Promise<SessionMessageEnqueueResult>;
}

interface SessionMessageRecipientRow {
  readonly cohort_id: CohortId;
  readonly execution_id: ExecutionId | null;
  readonly executor_type: string;
  readonly adapter_reference: JsonValue;
}

const deliverableReference = (value: JsonValue): ExternalExecutionReference | null => {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("kind" in value)) return null;
  if (value.kind === "kbbl_session" && typeof value.session_id === "string") {
    return { kind: "kbbl_session", session_id: value.session_id, ...(typeof value.worktree_base_sha === "string" ? { worktree_base_sha: value.worktree_base_sha } : {}) };
  }
  if (value.kind === "headless_run" && typeof value.run_ref === "string") return { kind: "headless_run", run_ref: value.run_ref };
  return null;
};

/** Resolves an agent recipient (a v15 session id) to its same-run executor target. */
export class PostgresSessionMessageRecipientResolver implements SessionMessageRecipientResolver {
  constructor(private readonly sql: SqlExecutor) {}

  async resolve(input: { readonly run_id: WorkflowRunId; readonly recipient: import("../domain/collaboration").MessageParty }): Promise<SessionMessageRecipientResolution> {
    if (input.recipient.kind !== "agent" || input.recipient.id === null) {
      return { kind: "recipient_not_deliverable", detail: "only an agent recipient with a session id can receive a session message" };
    }
    const sessionId = parseUuidId<SessionId>(input.recipient.id);
    if (!sessionId) return { kind: "recipient_not_deliverable", detail: "agent recipient id must be a session UUID" };
    const rows = await this.sql.query<SessionMessageRecipientRow>(`SELECT attempt.cohort_id::text,attempt.request->>'execution_id' AS execution_id,
      attempt.adapter_type AS executor_type,session.adapter_reference
      FROM oakridge.session session JOIN oakridge.attempt attempt ON attempt.id=session.attempt_id
      WHERE session.run_id=$1 AND session.id=$2`, [input.run_id, sessionId]);
    const row = rows[0];
    if (!row) return { kind: "recipient_not_deliverable", detail: `recipient session '${sessionId}' was not found in run '${input.run_id}'` };
    const externalReference = deliverableReference(row.adapter_reference);
    if (!row.execution_id || !externalReference) {
      return { kind: "recipient_not_deliverable", detail: `recipient session '${sessionId}' has no deliverable executor reference` };
    }
    return {
      kind: "resolved",
      cohort_id: row.cohort_id,
      target: {
        execution_id: row.execution_id,
        executor_type: row.executor_type,
        external_reference: externalReference,
      },
    };
  }
}

interface SessionMessageRow {
  readonly id: SessionMessageId;
  readonly run_id: WorkflowRunId;
  readonly cohort_id: CohortId | null;
  readonly sender_kind: SessionMessageRecord["sender_kind"];
  readonly sender_id: string | null;
  readonly recipient_kind: SessionMessageRecord["recipient_kind"];
  readonly recipient_id: string | null;
  readonly thread_id: SessionThreadId;
  readonly message_id: SessionThreadMessageId;
  readonly artifact_thread_id: SessionMessageRecord["artifact_thread_id"];
  readonly body: SessionMessageRecord["body"];
  readonly delivery_key: DeliveryKey;
  readonly delivery_status: SessionMessageRecord["delivery_status"];
  readonly delivery_result: SessionMessageDeliveryResult | null;
  readonly created_at: string;
  readonly delivered_at: string | null;
}

interface MatchedSessionMessageRow extends SessionMessageRow { readonly payload_matches: boolean }

const SESSION_MESSAGE_COLUMNS = `id,run_id,cohort_id,sender_kind,sender_id,recipient_kind,recipient_id,
  thread_id,message_id,artifact_thread_id,body,delivery_key,delivery_status,delivery_result,created_at::text,delivered_at::text`;

const sessionMessageRecord = (row: SessionMessageRow): SessionMessageRecord => ({
  id: row.id, run_id: row.run_id, cohort_id: row.cohort_id,
  sender: { kind: row.sender_kind, id: row.sender_id }, sender_kind: row.sender_kind, sender_id: row.sender_id,
  recipient: { kind: row.recipient_kind, id: row.recipient_id }, recipient_kind: row.recipient_kind, recipient_id: row.recipient_id,
  thread_id: row.thread_id, message_id: row.message_id, artifact_thread_id: row.artifact_thread_id,
  body: row.body, delivery_key: row.delivery_key, delivery_status: row.delivery_status,
  delivery_result: row.delivery_result, created_at: row.created_at, delivered_at: row.delivered_at,
} as SessionMessageRecord);

/** PostgreSQL implementation of the c1 oakridge.session_message contract. */
export class PostgresSessionMessageRepository implements SessionMessageRepository {
  constructor(private readonly sql: TransactionalSqlExecutor) {}

  async put_pending(message: SessionMessage): Promise<import("../domain/collaboration").PutSessionMessageResult> {
    return this.sql.transaction(async (transaction) => {
      const inserted = await transaction.query<{ readonly id: SessionMessageId }>(`INSERT INTO oakridge.session_message
        (id,run_id,cohort_id,sender_kind,sender_id,recipient_kind,recipient_id,thread_id,message_id,artifact_thread_id,body,delivery_key,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13::timestamptz)
        ON CONFLICT DO NOTHING RETURNING id`, [
        message.id, message.run_id, message.cohort_id, message.sender.kind, message.sender.id,
        message.recipient.kind, message.recipient.id, message.thread_id, message.message_id,
        message.artifact_thread_id, JSON.stringify(message.body), message.delivery_key, message.created_at,
      ]);
      const rows = await transaction.query<MatchedSessionMessageRow>(`SELECT ${SESSION_MESSAGE_COLUMNS},
        cohort_id IS NOT DISTINCT FROM $1::uuid AND sender_kind=$2 AND sender_id IS NOT DISTINCT FROM $3
          AND recipient_kind=$4 AND recipient_id IS NOT DISTINCT FROM $5 AND thread_id=$6 AND message_id=$7
          AND artifact_thread_id IS NOT DISTINCT FROM $8::uuid AND body=$9::jsonb AS payload_matches
        FROM oakridge.session_message WHERE run_id=$10 AND delivery_key=$11`, [
        message.cohort_id, message.sender.kind, message.sender.id,
        message.recipient.kind, message.recipient.id, message.thread_id, message.message_id,
        message.artifact_thread_id, JSON.stringify(message.body), message.run_id, message.delivery_key,
      ]);
      const row = rows[0];
      if (!row) {
        const identityRows = await transaction.query<SessionMessageRow>(`SELECT ${SESSION_MESSAGE_COLUMNS}
          FROM oakridge.session_message WHERE run_id=$1 AND thread_id=$2 AND message_id=$3`, [
          message.run_id, message.thread_id, message.message_id,
        ]);
        if (identityRows[0]) return {
          kind: "idempotency_conflict",
          detail: `message '${message.thread_id}/${message.message_id}' was already submitted with a different delivery key`,
        };
        throw new Error(`session message '${message.delivery_key}' was not persisted`);
      }
      if (!row.payload_matches) return { kind: "idempotency_conflict", detail: `delivery key '${message.delivery_key}' was already used with a different message` };
      return { kind: inserted.length > 0 ? "created" : "existing", message: sessionMessageRecord(row) };
    });
  }

  async find_by_delivery_key(run_id: WorkflowRunId, delivery_key: DeliveryKey): Promise<SessionMessageRecord | null> {
    const rows = await this.sql.query<SessionMessageRow>(`SELECT ${SESSION_MESSAGE_COLUMNS}
      FROM oakridge.session_message WHERE run_id=$1 AND delivery_key=$2`, [run_id, delivery_key]);
    return rows[0] ? sessionMessageRecord(rows[0]) : null;
  }

  async record_delivery_result(message_id: SessionMessageId, result: SessionMessageDeliveryResult, recorded_at: string): Promise<SessionMessageRecord> {
    return this.sql.transaction(async (transaction) => {
      await transaction.query(`UPDATE oakridge.session_message SET delivery_status=$2::oakridge.delivery_status,delivery_result=$3::jsonb,
        delivered_at=CASE WHEN $2::text='delivered' THEN $4::timestamptz ELSE NULL END
        WHERE id=$1 AND delivery_status='pending'`, [message_id, result.kind, JSON.stringify(result), recorded_at]);
      const rows = await transaction.query<SessionMessageRow>(`SELECT ${SESSION_MESSAGE_COLUMNS}
        FROM oakridge.session_message WHERE id=$1`, [message_id]);
      if (!rows[0]) throw new Error(`session message '${message_id}' was not found`);
      return sessionMessageRecord(rows[0]);
    });
  }

  async list_for_run(run_id: WorkflowRunId, cohort_id?: CohortId): Promise<readonly SessionMessageRecord[]> {
    const rows = await this.sql.query<SessionMessageRow>(`SELECT ${SESSION_MESSAGE_COLUMNS}
      FROM oakridge.session_message WHERE run_id=$1 AND ($2::uuid IS NULL OR cohort_id=$2)
      ORDER BY created_at,message_id`, [run_id, cohort_id ?? null]);
    return rows.map(sessionMessageRecord);
  }
}

export class DbosCollaborationPingClient implements CollaborationPingClient {
  constructor(
    private readonly client: DBOSClient,
    private readonly application_version: string,
    private readonly messages: SessionMessageRepository,
  ) { registerSessionMessageRepository(messages); }

  async enqueue(input: DeliverSessionMessage): Promise<SessionMessageEnqueueResult> {
    const persisted = await this.messages.put_pending(input.message);
    if (persisted.kind === "idempotency_conflict") return persisted;
    const workflowId = `oakridge-session-message:${input.message.run_id}:${input.message.delivery_key}`;
    if (isTerminalSessionMessageDelivery(persisted.message.delivery_status)) {
      return { kind: "accepted", message: persisted.message, workflow_id: workflowId };
    }
    await this.client.enqueuePortable({
      queueName: "_dbos_internal_queue",
      workflowName: "oakridgeCollaborationResponderWorkflow",
      workflowID: workflowId,
      appVersion: this.application_version,
    }, [input]);
    return { kind: "accepted", message: persisted.message, workflow_id: workflowId };
  }
}
