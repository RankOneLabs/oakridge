import { randomUUID } from "node:crypto";

import { Hono } from "hono";

import { renderCollaborationPingPrompt, renderSessionMessagePrompt, validateDeliveryKey, type CollaborationMessage, type CollaborationThread, type DeliverSessionMessage, type MessageId, type MessageParty, type SessionMessage, type SessionMessageEnqueueResult, type SessionMessageRecipientResolver, type SessionMessageRepository, type SessionThreadId, type SessionThreadMessageId, type ThreadId, type ThreadStatus } from "../domain/collaboration";
import { isJsonValue, parseUuidId, type ArtifactId, type CohortId, type SessionMessageId, type WorkflowRunId } from "../domain/primitives";
import type { ArtifactRevision } from "../domain/artifacts";
import type { ArtifactRevisionRepository, CollaborationRepository } from "../storage/repositories";

export interface ArtifactCollaborationPolicy {
  readonly commentable: boolean;
  readonly atom_editable?: boolean;
}
export interface CollaborationHttpDependencies {
  readonly artifacts: ArtifactRevisionRepository;
  readonly collaboration: CollaborationRepository;
  readonly policy_for_artifact_type: (artifact_type: string) => ArtifactCollaborationPolicy | null;
  readonly messages?: Pick<SessionMessageRepository, "find_by_delivery_key" | "list_for_run">;
  readonly message_recipients?: SessionMessageRecipientResolver;
  readonly send_message?: (input: DeliverSessionMessage) => Promise<SessionMessageEnqueueResult>;
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
    if (!dependencies.send_message || !dependencies.message_recipients) return http.json({ error: "session messaging is unavailable" }, 503);
    const runId = parseUuidId<WorkflowRunId>(http.req.param("run_id"));
    if (!runId) return http.json({ error: "run id must be a UUID" }, 400);
    const key = validateDeliveryKey(http.req.header("idempotency-key") ?? "");
    if (key.kind === "invalid") return http.json({ error: key.detail }, 400);
    const body = await objectBody(http.req.raw);
    const recipient = messageParty(body?.recipient);
    const threadId = sessionThreadId(body?.thread_id); const messageId = sessionThreadMessageId(body?.message_id) ?? sessionThreadMessageId(key.delivery_key)!;
    const artifactThreadId = body?.artifact_thread_id === undefined || body.artifact_thread_id === null ? null : parseUuidId<ThreadId>(String(body.artifact_thread_id));
    if (!body || !recipient || !threadId || !isJsonValue(body.body) || (body.artifact_thread_id !== undefined && body.artifact_thread_id !== null && !artifactThreadId)) {
      return http.json({ error: "recipient, thread_id, and JSON body are required; artifact_thread_id must be a UUID or null" }, 400);
    }
    const resolution = await dependencies.message_recipients.resolve({ run_id: runId, recipient });
    if (resolution.kind === "recipient_not_deliverable") return http.json({ error: resolution.detail, code: resolution.kind }, 409);
    const message: SessionMessage = {
      id: newId() as SessionMessageId, run_id: runId, cohort_id: resolution.cohort_id, sender: { kind: "operator", id: "operator" }, recipient,
      thread_id: threadId, message_id: messageId, artifact_thread_id: artifactThreadId,
      body: body.body, delivery_key: key.delivery_key, created_at: now(),
    };
    const result = await dependencies.send_message({ message, target: resolution.target, prompt: renderSessionMessagePrompt(message.body) });
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
    if (!dependencies.message_recipients) return http.json({ error: "session messaging is unavailable" }, 503);
    // The agent to ping is the session that produced the revision. v14 went
    // through the work order's executor attachment; v15's session *is* that
    // attachment, and one resolver already turns a session id into a delivery
    // target for every sender.
    if (!threadRevision.session_id) return http.json({ error: "thread artifact was not produced by an agent session" }, 409);
    const prompt = renderCollaborationPingPrompt(fullThread);
    const createdAt = now();
    const message: SessionMessage = {
      id: newId() as SessionMessageId, run_id: threadRevision.run_id, cohort_id: threadRevision.cohort_id,
      sender: { kind: "operator", id: "operator" }, recipient: { kind: "agent", id: threadRevision.session_id },
      thread_id: sessionThreadId(threadId)!, message_id: sessionThreadMessageId(key.delivery_key)!, artifact_thread_id: threadId,
      body: prompt, delivery_key: key.delivery_key, created_at: createdAt,
    };
    const resolution = await dependencies.message_recipients.resolve({ run_id: message.run_id, recipient: message.recipient });
    if (resolution.kind === "recipient_not_deliverable") return http.json({ error: resolution.detail, code: resolution.kind }, 409);
    const accepted = await dependencies.ping_thread({
      message: { ...message, cohort_id: resolution.cohort_id }, target: resolution.target, prompt: renderSessionMessagePrompt(message.body),
    });
    return accepted.kind === "idempotency_conflict"
      ? http.json({ error: accepted.detail, code: accepted.kind }, 409)
      : http.json({ ok: true, ...accepted }, 202);
  });
  /**
   * v1's `emit_revision` superseded an artifact's pending revision in place;
   * the v15 run record has no equivalent operation. `publish_artifact`
   * (`storage/postgres-run-record-repository.ts`) hands one artifact to a
   * declared machine output and refuses a conflicting publication. A replacement after a rejection is a *different attempt's* to
   * publish, which is what makes the revision chain a chain. There is nothing
   * here left to build a body edit on top of — no route can construct a publish
   * call that would succeed. The route stays mounted because kbbl's direct-edit
   * UI still calls it and surfaces the `error` string to the operator; 501 is
   * the honest status for that — "not implemented", not a conflict this request
   * could ever resolve by retrying.
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
  return app;
};
