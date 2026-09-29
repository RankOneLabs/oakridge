import { randomUUID } from "node:crypto";

import { Hono } from "hono";

import { renderCollaborationPingPrompt, renderSessionMessagePrompt, validateDeliveryKey, type CollaborationMessage, type CollaborationThread, type DeliverSessionMessage, type MessageId, type MessageParty, type ReviewItem, type ReviewItemId, type ReviewItemStatus, type SessionMessage, type SessionMessageEnqueueResult, type SessionMessageRepository, type SessionThreadId, type SessionThreadMessageId, type ThreadId, type ThreadStatus } from "../domain/collaboration";
import { isJsonValue, parseUuidId, type ArtifactId, type CohortId, type SessionMessageId, type WorkflowRunId } from "../domain/primitives";
import { workOrderIdOfArtifact, type ArtifactRevision } from "../domain/artifacts";
import type { ArtifactRevisionRepository, CollaborationRepository, RunRecordRepository } from "../storage/repositories";

export interface ArtifactCollaborationPolicy {
  readonly commentable: boolean;
  readonly review_items: boolean;
  readonly atom_editable?: boolean;
}
export interface CollaborationHttpDependencies {
  readonly artifacts: ArtifactRevisionRepository;
  readonly collaboration: CollaborationRepository;
  readonly policy_for_artifact_type: (artifact_type: string) => ArtifactCollaborationPolicy | null;
  readonly records: Pick<RunRecordRepository, "find_work_order_attachment">;
  readonly messages?: Pick<SessionMessageRepository, "find_by_delivery_key" | "list_for_run">;
  readonly send_message?: (message: SessionMessage) => Promise<SessionMessageEnqueueResult>;
  readonly ping_thread: (input: DeliverSessionMessage) => Promise<SessionMessageEnqueueResult>;
  readonly now?: () => string;
  readonly new_id?: () => string;
}

const objectBody = async (request: Request): Promise<Record<string, unknown> | null> => {
  try { const value: unknown = await request.json(); return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; }
  catch { return null; }
};
const nonempty = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;
const PARTY_KINDS = new Set<MessageParty["kind"]>(["core", "agent", "service", "operator"]);
const messageParty = (value: unknown): MessageParty | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as { readonly kind?: unknown; readonly id?: unknown };
  if (typeof candidate.kind !== "string" || !PARTY_KINDS.has(candidate.kind as MessageParty["kind"])) return null;
  if (candidate.id !== null && typeof candidate.id !== "string") return null;
  return { kind: candidate.kind as MessageParty["kind"], id: candidate.id };
};
const sessionThreadId = (value: unknown): SessionThreadId | null => nonempty(value) as SessionThreadId | null;
const sessionThreadMessageId = (value: unknown): SessionThreadMessageId | null => nonempty(value) as SessionThreadMessageId | null;

export const createCollaborationApp = (dependencies: CollaborationHttpDependencies): Hono => {
  const app = new Hono();
  const now = () => (dependencies.now ?? (() => new Date().toISOString()))();
  const newId = () => (dependencies.new_id ?? randomUUID)();
  const isMutable = (artifact: ArtifactRevision): boolean => artifact.lifecycle.kind === "current";

  app.get("/runs/:run_id/messages", async (http) => {
    if (!dependencies.messages) return http.json({ error: "session messaging is unavailable" }, 503);
    const runId = parseUuidId<WorkflowRunId>(http.req.param("run_id"));
    if (!runId) return http.json({ error: "run id must be a UUID" }, 400);
    const rawCohortId = http.req.query("cohort_id");
    const cohortId: CohortId | undefined = rawCohortId === undefined ? undefined : parseUuidId<CohortId>(rawCohortId) ?? undefined;
    if (rawCohortId !== undefined && !cohortId) return http.json({ error: "cohort id must be a UUID" }, 400);
    return http.json(await dependencies.messages.list_for_run(runId, cohortId));
  });
  app.get("/runs/:run_id/messages/:delivery_key", async (http) => {
    if (!dependencies.messages) return http.json({ error: "session messaging is unavailable" }, 503);
    const runId = parseUuidId<WorkflowRunId>(http.req.param("run_id"));
    if (!runId) return http.json({ error: "run id must be a UUID" }, 400);
    const key = validateDeliveryKey(http.req.param("delivery_key"));
    if (key.kind === "invalid") return http.json({ error: key.detail }, 400);
    const message = await dependencies.messages.find_by_delivery_key(runId, key.delivery_key);
    return message ? http.json(message) : http.json({ error: "message not found" }, 404);
  });
  app.post("/runs/:run_id/messages", async (http) => {
    if (!dependencies.send_message) return http.json({ error: "session messaging is unavailable" }, 503);
    const runId = parseUuidId<WorkflowRunId>(http.req.param("run_id"));
    if (!runId) return http.json({ error: "run id must be a UUID" }, 400);
    const key = validateDeliveryKey(http.req.header("idempotency-key") ?? "");
    if (key.kind === "invalid") return http.json({ error: key.detail }, 400);
    const body = await objectBody(http.req.raw);
    const sender = messageParty(body?.sender); const recipient = messageParty(body?.recipient);
    const threadId = sessionThreadId(body?.thread_id); const messageId = sessionThreadMessageId(body?.message_id) ?? sessionThreadMessageId(key.delivery_key)!;
    const cohortId = body?.cohort_id === undefined || body.cohort_id === null ? null : parseUuidId<CohortId>(String(body.cohort_id));
    const artifactThreadId = body?.artifact_thread_id === undefined || body.artifact_thread_id === null ? null : parseUuidId<ThreadId>(String(body.artifact_thread_id));
    if (!body || !sender || !recipient || !threadId || !isJsonValue(body.body) || (body.cohort_id !== undefined && body.cohort_id !== null && !cohortId) || (body.artifact_thread_id !== undefined && body.artifact_thread_id !== null && !artifactThreadId)) {
      return http.json({ error: "sender, recipient, thread_id, and JSON body are required; cohort_id and artifact_thread_id must be UUIDs or null" }, 400);
    }
    const message: SessionMessage = {
      id: newId() as SessionMessageId, run_id: runId, cohort_id: cohortId, sender, recipient,
      thread_id: threadId, message_id: messageId, artifact_thread_id: artifactThreadId,
      body: body.body, delivery_key: key.delivery_key, created_at: now(),
    };
    const result = await dependencies.send_message(message);
    return result.kind === "idempotency_conflict" ? http.json({ error: result.detail, code: result.kind }, 409) : http.json(result, 202);
  });

  app.get("/artifacts/:id/threads", async (http) => {
    const artifactId = parseUuidId<ArtifactId>(http.req.param("id"));
    const artifact = artifactId && await dependencies.artifacts.find_by_id(artifactId);
    if (!artifact) return http.json({ error: "artifact not found" }, 404);
    if (!dependencies.policy_for_artifact_type(artifact.artifact_type)?.commentable) return http.json({ error: `artifact type '${artifact.artifact_type}' does not support 'commentable'` }, 400);
    return http.json(await dependencies.collaboration.list_threads(artifact.chain_id));
  });
  app.post("/artifacts/:id/threads", async (http) => {
    const artifactId = parseUuidId<ArtifactId>(http.req.param("id"));
    const artifact = artifactId && await dependencies.artifacts.find_by_id(artifactId);
    if (!artifact) return http.json({ error: "artifact not found" }, 404);
    if (!isMutable(artifact)) return http.json({ error: "artifact revision is not current", code: artifact.lifecycle.kind }, 409);
    if (!dependencies.policy_for_artifact_type(artifact.artifact_type)?.commentable) return http.json({ error: `artifact type '${artifact.artifact_type}' does not support 'commentable'` }, 400);
    const body = await objectBody(http.req.raw); const text = nonempty(body?.body); const author = nonempty(body?.author);
    if (!body || !text || !author || (body.anchor !== undefined && body.anchor !== null && typeof body.anchor !== "string")) return http.json({ error: "body and author are required; anchor must be a string or null" }, 400);
    const threadId = newId() as ThreadId; const messageId = newId() as MessageId; const createdAt = now();
    const thread: CollaborationThread = { id: threadId, artifact_id: artifact.chain_id, revision_id: artifact.id, anchor: typeof body.anchor === "string" ? body.anchor : null, status: "open", created_at: createdAt };
    const message: CollaborationMessage = { id: messageId, thread_id: threadId, body: text, author, created_at: createdAt };
    const result = await dependencies.collaboration.insert_thread_with_message(thread, message);
    return http.json(result, 201);
  });
  app.post("/threads/:id/messages", async (http) => {
    const threadId = parseUuidId<ThreadId>(http.req.param("id"));
    const thread = threadId && await dependencies.collaboration.find_thread(threadId);
    if (!thread) return http.json({ error: "thread not found" }, 404);
    const threadRevision = await dependencies.artifacts.find_by_id(thread.revision_id);
    if (!threadRevision || !isMutable(threadRevision)) return http.json({ error: "thread artifact revision is not current", code: threadRevision?.lifecycle.kind ?? "not_found" }, 409);
    if (thread.status !== "open") return http.json({ error: "cannot post to a resolved thread" }, 400);
    const body = await objectBody(http.req.raw); const text = nonempty(body?.body); const author = nonempty(body?.author);
    if (!text || !author) return http.json({ error: "body and author are required" }, 400);
    const message: CollaborationMessage = { id: newId() as MessageId, thread_id: threadId, body: text, author, created_at: now() };
    return http.json({ message_id: await dependencies.collaboration.insert_message(message) }, 201);
  });
  app.patch("/threads/:id", async (http) => {
    const threadId = parseUuidId<ThreadId>(http.req.param("id"));
    const thread = threadId && await dependencies.collaboration.find_thread(threadId); if (!thread) return http.json({ error: "thread not found" }, 404);
    const threadRevision = await dependencies.artifacts.find_by_id(thread.revision_id);
    if (!threadRevision || !isMutable(threadRevision)) return http.json({ error: "thread artifact revision is not current", code: threadRevision?.lifecycle.kind ?? "not_found" }, 409);
    const body = await objectBody(http.req.raw); const status = body?.status;
    if (status !== "open" && status !== "resolved") return http.json({ error: "status must be 'open' or 'resolved'" }, 400);
    await dependencies.collaboration.update_thread_status(threadId, status as ThreadStatus);
    return http.json({ thread_id: threadId, status });
  });
  app.post("/threads/:id/ping", async (http) => {
    const threadId = parseUuidId<ThreadId>(http.req.param("id"));
    const thread = threadId && await dependencies.collaboration.find_thread(threadId);
    if (!thread) return http.json({ error: "thread not found" }, 404);
    const threadRevision = await dependencies.artifacts.find_by_id(thread.revision_id);
    if (!threadRevision || !isMutable(threadRevision)) return http.json({ error: "thread artifact revision is not current", code: threadRevision?.lifecycle.kind ?? "not_found" }, 409);
    if (thread.status !== "open") return http.json({ error: "cannot ping a resolved thread" }, 400);
    const threads = await dependencies.collaboration.list_threads(thread.artifact_id);
    const fullThread = threads.find((candidate) => candidate.id === threadId);
    if (!fullThread || !fullThread.messages.length) return http.json({ error: "thread has no durable messages" }, 409);
    const key = validateDeliveryKey(http.req.header("idempotency-key") ?? randomUUID());
    if (key.kind === "invalid") return http.json({ error: key.detail }, 400);
    const workOrderId = workOrderIdOfArtifact(threadRevision);
    if (!workOrderId) return http.json({ error: "thread artifact was not produced by a work order" }, 409);
    const attachment = await dependencies.records.find_work_order_attachment(workOrderId);
    if (!attachment || attachment.external_reference === null) return http.json({ error: "thread executor is not attached" }, 409);
    const prompt = renderCollaborationPingPrompt(fullThread);
    const createdAt = now();
    const message: SessionMessage = {
      id: newId() as SessionMessageId, run_id: threadRevision.run_id, cohort_id: null,
      sender: { kind: "operator", id: "operator" }, recipient: { kind: "agent", id: String(threadRevision.execution_id) },
      thread_id: sessionThreadId(threadId)!, message_id: sessionThreadMessageId(key.delivery_key)!, artifact_thread_id: threadId,
      body: prompt, delivery_key: key.delivery_key, created_at: createdAt,
    };
    const accepted = await dependencies.ping_thread({
      message,
      target: { execution_id: threadRevision.execution_id, executor_type: attachment.executor_type, external_reference: attachment.external_reference },
      prompt: renderSessionMessagePrompt(message.body),
    });
    return accepted.kind === "idempotency_conflict"
      ? http.json({ error: accepted.detail, code: accepted.kind }, 409)
      : http.json({ ok: true, ...accepted }, 202);
  });
  /**
   * v1's `emit_revision` superseded an artifact's pending revision in place;
   * the v2 run record has no equivalent operation. `publish_artifact`
   * (`storage/postgres-run-record.ts`) hands one artifact to an output slot
   * and refuses a second publication against the same slot in every state a
   * `current` artifact can be found in: `slot_pending` while the artifact
   * awaits its gate, `slot_already_released` or `slot_invalidated` once the
   * gate has decided. There is nothing here left to build a body edit
   * on top of — no route can construct a publish call that would succeed.
   * `tests/postgres-run-record.test.ts` records the missing operation itself
   * as a deferred "later slice"; building it is a decision-layer change the
   * operator makes separately. The route stays mounted because kbbl's
   * direct-edit UI still calls it and surfaces the `error` string to the
   * operator; 501 is the honest status for that — "not implemented", not a
   * conflict this request could ever resolve by retrying.
   */
  app.post("/artifacts/:id/edits", async (http) => {
    const artifactId = parseUuidId<ArtifactId>(http.req.param("id"));
    const artifact = artifactId && await dependencies.artifacts.find_by_id(artifactId);
    if (!artifact) return http.json({ error: "artifact not found" }, 404);
    if (!isMutable(artifact)) return http.json({ error: "artifact revision is not current", code: artifact.lifecycle.kind }, 409);
    const policy = dependencies.policy_for_artifact_type(artifact.artifact_type);
    if (!policy?.atom_editable) return http.json({ error: `artifact type '${artifact.artifact_type}' does not support 'atom_editable'` }, 400);
    return http.json({ error: "operator edits are not supported: a run-owned artifact has no revision operation — a published output slot holds one artifact until its gate decides", code: "revision_unsupported" }, 501);
  });
  app.get("/artifacts/:id/review_items", async (http) => {
    const artifactId = parseUuidId<ArtifactId>(http.req.param("id"));
    const artifact = artifactId && await dependencies.artifacts.find_by_id(artifactId);
    if (!artifact) return http.json({ error: "artifact not found" }, 404);
    if (!dependencies.policy_for_artifact_type(artifact.artifact_type)?.review_items) return http.json({ error: `artifact type '${artifact.artifact_type}' does not support 'review_items'` }, 400);
    return http.json(await dependencies.collaboration.list_review_items(artifact.chain_id));
  });
  app.post("/artifacts/:id/review_items", async (http) => {
    const artifactId = parseUuidId<ArtifactId>(http.req.param("id"));
    const artifact = artifactId && await dependencies.artifacts.find_by_id(artifactId);
    if (!artifact) return http.json({ error: "artifact not found" }, 404);
    if (!isMutable(artifact)) return http.json({ error: "artifact revision is not current", code: artifact.lifecycle.kind }, 409);
    if (!dependencies.policy_for_artifact_type(artifact.artifact_type)?.review_items) return http.json({ error: `artifact type '${artifact.artifact_type}' does not support 'review_items'` }, 400);
    const body = await objectBody(http.req.raw); const anchor = nonempty(body?.anchor); const claim = nonempty(body?.claim); const reality = nonempty(body?.reality);
    if (!anchor || !claim || !reality) return http.json({ error: "anchor, claim, and reality are required" }, 400);
    const item: ReviewItem = { id: newId() as ReviewItemId, artifact_id: artifact.chain_id, revision_id: artifact.id, anchor, claim, reality, status: "open", resolution: null, created_at: now() };
    await dependencies.collaboration.insert_review_item(item); return http.json(item, 201);
  });
  app.patch("/review_items/:id", async (http) => {
    const id = parseUuidId<ReviewItemId>(http.req.param("id"));
    const existingItem = id && await dependencies.collaboration.find_review_item(id); if (!existingItem) return http.json({ error: "review item not found" }, 404);
    const itemRevision = await dependencies.artifacts.find_by_id(existingItem.revision_id);
    if (!itemRevision || !isMutable(itemRevision)) return http.json({ error: "review-item artifact revision is not current", code: itemRevision?.lifecycle.kind ?? "not_found" }, 409);
    const body = await objectBody(http.req.raw); const status = body?.status;
    if (status !== "open" && status !== "resolved" && status !== "waived") return http.json({ error: "invalid review-item status" }, 400);
    const resolution = body?.resolution === null || body?.resolution === undefined ? null : nonempty(body.resolution);
    if (body?.resolution !== null && body?.resolution !== undefined && !resolution) return http.json({ error: "resolution must be a non-empty string or null" }, 400);
    await dependencies.collaboration.update_review_item(id, status as ReviewItemStatus, resolution);
    const updated = await dependencies.collaboration.find_review_item(id); return http.json(updated!);
  });
  return app;
};
