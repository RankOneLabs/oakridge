import { createHash, randomUUID } from "node:crypto";

import { Hono } from "hono";

import { renderCollaborationPingPrompt, type CollaborationMessage, type CollaborationPingAccepted, type CollaborationPingRequestId, type CollaborationThread, type MessageId, type ReviewItem, type ReviewItemId, type ReviewItemStatus, type ThreadId, type ThreadStatus } from "../domain/collaboration";
import type { ArtifactId, JsonValue } from "../domain/primitives";
import type { ArtifactRevision } from "../domain/artifacts";
import type { ArtifactRevisionRepository, CollaborationRepository, ExecutionArtifactContextRepository, ExecutionProjectionRepository } from "../storage/repositories";

export interface ArtifactCollaborationPolicy {
  readonly commentable: boolean;
  readonly review_items: boolean;
  readonly atom_editable?: boolean;
  readonly anchor_schema?: readonly string[] | null;
  readonly validate_body?: (body: JsonValue) => boolean;
}
export interface CollaborationHttpDependencies {
  readonly artifacts: ArtifactRevisionRepository;
  readonly contexts: ExecutionArtifactContextRepository;
  readonly collaboration: CollaborationRepository;
  readonly policy_for_artifact_type: (artifact_type: string) => ArtifactCollaborationPolicy | null;
  readonly executions: Pick<ExecutionProjectionRepository, "find_external">;
  readonly ping_thread: (input: import("../domain/collaboration").CollaborationPingRequest) => Promise<CollaborationPingAccepted>;
  readonly dispatch_notifications: () => Promise<number>;
  readonly now?: () => string;
  readonly new_id?: () => string;
}

const objectBody = async (request: Request): Promise<Record<string, unknown> | null> => {
  try { const value: unknown = await request.json(); return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; }
  catch { return null; }
};
const nonempty = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;
const isJsonValue = (value: unknown): value is JsonValue => value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean" || (Array.isArray(value) ? value.every(isJsonValue) : typeof value === "object" && Object.values(value).every(isJsonValue));
const anchorAllowed = (anchor: string, schema: readonly string[]): boolean => schema.some((prefix) => anchor === prefix || anchor.startsWith(`${prefix}/`));
const decodePointerSegment = (segment: string): string => segment.replace(/~1/g, "/").replace(/~0/g, "~");
const editJsonPointer = (body: JsonValue, pointer: string, previous: JsonValue, replacement: JsonValue): JsonValue | null => {
  if (!pointer.startsWith("/") || pointer === "/") return null;
  const clone = structuredClone(body) as JsonValue;
  const segments = pointer.slice(1).split("/").map(decodePointerSegment);
  let cursor: unknown = clone;
  for (const segment of segments.slice(0, -1)) {
    if (Array.isArray(cursor)) { const index = Number(segment); if (!Number.isInteger(index) || index < 0 || index >= cursor.length) return null; cursor = cursor[index]; }
    else if (typeof cursor === "object" && cursor !== null && segment in cursor) cursor = (cursor as Record<string, unknown>)[segment];
    else return null;
  }
  const leaf = segments.at(-1)!; let current: unknown;
  if (Array.isArray(cursor)) { const index = Number(leaf); if (!Number.isInteger(index) || index < 0 || index >= cursor.length) return null; current = cursor[index]; if (JSON.stringify(current) !== JSON.stringify(previous)) return null; cursor[index] = replacement; }
  else if (typeof cursor === "object" && cursor !== null && leaf in cursor) { current = (cursor as Record<string, unknown>)[leaf]; if (JSON.stringify(current) !== JSON.stringify(previous)) return null; (cursor as Record<string, JsonValue>)[leaf] = replacement; }
  else return null;
  return clone;
};

export const createCollaborationApp = (dependencies: CollaborationHttpDependencies): Hono => {
  const app = new Hono();
  const now = () => (dependencies.now ?? (() => new Date().toISOString()))();
  const newId = () => (dependencies.new_id ?? randomUUID)();
  const isMutable = (artifact: ArtifactRevision): boolean => artifact.lifecycle.kind === "current";

  app.get("/artifacts/:id/threads", async (http) => {
    const artifact = await dependencies.artifacts.find_by_id(http.req.param("id") as ArtifactId);
    if (!artifact) return http.json({ error: "artifact not found" }, 404);
    if (!dependencies.policy_for_artifact_type(artifact.artifact_type)?.commentable) return http.json({ error: `artifact type '${artifact.artifact_type}' does not support 'commentable'` }, 400);
    return http.json(await dependencies.collaboration.list_threads(artifact.chain_id));
  });
  app.post("/artifacts/:id/threads", async (http) => {
    const artifact = await dependencies.artifacts.find_by_id(http.req.param("id") as ArtifactId);
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
    const threadId = http.req.param("id") as ThreadId; const thread = await dependencies.collaboration.find_thread(threadId);
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
    const threadId = http.req.param("id") as ThreadId; const thread = await dependencies.collaboration.find_thread(threadId); if (!thread) return http.json({ error: "thread not found" }, 404);
    const threadRevision = await dependencies.artifacts.find_by_id(thread.revision_id);
    if (!threadRevision || !isMutable(threadRevision)) return http.json({ error: "thread artifact revision is not current", code: threadRevision?.lifecycle.kind ?? "not_found" }, 409);
    const body = await objectBody(http.req.raw); const status = body?.status;
    if (status !== "open" && status !== "resolved") return http.json({ error: "status must be 'open' or 'resolved'" }, 400);
    await dependencies.collaboration.update_thread_status(threadId, status as ThreadStatus);
    return http.json({ thread_id: threadId, status });
  });
  app.post("/threads/:id/ping", async (http) => {
    const threadId = http.req.param("id") as ThreadId; const thread = await dependencies.collaboration.find_thread(threadId);
    if (!thread) return http.json({ error: "thread not found" }, 404);
    const threadRevision = await dependencies.artifacts.find_by_id(thread.revision_id);
    if (!threadRevision || !isMutable(threadRevision)) return http.json({ error: "thread artifact revision is not current", code: threadRevision?.lifecycle.kind ?? "not_found" }, 409);
    if (thread.status !== "open") return http.json({ error: "cannot ping a resolved thread" }, 400);
    const threads = await dependencies.collaboration.list_threads(thread.artifact_id);
    const fullThread = threads.find((candidate) => candidate.id === threadId);
    if (!fullThread || !fullThread.messages.length) return http.json({ error: "thread has no durable messages" }, 409);
    const requestId = (http.req.header("idempotency-key")?.trim() || randomUUID()) as CollaborationPingRequestId;
    const context = await dependencies.contexts.find_for_emit(threadRevision.stage_instance_id, threadRevision.unit_id);
    if (!context || context.execution_id !== threadRevision.execution_id) return http.json({ error: "thread execution context is unavailable" }, 409);
    const execution = await dependencies.executions.find_external(context.execution_id);
    if (!execution) return http.json({ error: "thread executor is not attached" }, 409);
    const accepted = await dependencies.ping_thread({
      thread_id: threadId, request_id: requestId, execution_id: context.execution_id,
      executor_type: execution.executor_type, external_reference: execution.external_reference,
      prompt: renderCollaborationPingPrompt(fullThread),
    });
    return http.json({ ok: true, ...accepted }, 202);
  });
  app.post("/artifacts/:id/edits", async (http) => {
    const artifact = await dependencies.artifacts.find_by_id(http.req.param("id") as ArtifactId);
    if (!artifact) return http.json({ error: "artifact not found" }, 404);
    if (!isMutable(artifact)) return http.json({ error: "artifact revision is not current", code: artifact.lifecycle.kind }, 409);
    const policy = dependencies.policy_for_artifact_type(artifact.artifact_type);
    if (!policy?.atom_editable) return http.json({ error: `artifact type '${artifact.artifact_type}' does not support 'atom_editable'` }, 400);
    const body = await objectBody(http.req.raw); const anchor = nonempty(body?.anchor); const author = nonempty(body?.author);
    if (!anchor || !author || !isJsonValue(body?.prev_value) || !isJsonValue(body?.new_value)) return http.json({ error: "anchor, author, prev_value, and new_value are required" }, 400);
    if (policy.anchor_schema && !anchorAllowed(anchor, policy.anchor_schema)) return http.json({ error: `anchor '${anchor}' is not in the artifact anchor schema` }, 400);
    const current = await dependencies.artifacts.find_current(artifact.stage_instance_id, artifact.execution_id, artifact.unit_id, artifact.output_name);
    if (!current || current.id !== artifact.id) return http.json({ error: "concurrent edit: artifact revision is stale" }, 409);
    const edited = editJsonPointer(artifact.body, anchor, body.prev_value, body.new_value);
    if (!edited) return http.json({ error: `prev_value mismatch or anchor '${anchor}' was not found` }, 409);
    if (policy.validate_body && !policy.validate_body(edited)) return http.json({ error: "edited artifact body failed type validation" }, 400);
    const execution = await dependencies.contexts.find_for_emit(artifact.stage_instance_id, artifact.unit_id);
    const output = execution?.outputs.find((candidate) => candidate.name === artifact.output_name);
    if (!execution || !output) return http.json({ error: "artifact execution context is unavailable" }, 409);
    const payload = JSON.stringify({ anchor, prev_value: body.prev_value, new_value: body.new_value, author });
    const payloadHash = createHash("sha256").update(payload).digest("hex");
    const result = await dependencies.artifacts.emit_revision(newId() as ArtifactId, {
      run_id: artifact.run_id, stage_instance_id: artifact.stage_instance_id, execution_id: artifact.execution_id, unit_id: artifact.unit_id,
      output_name: artifact.output_name, artifact_type: artifact.artifact_type, label: artifact.label, body: edited,
      idempotency_key: http.req.header("idempotency-key")?.trim() || `edit:${payloadHash}`, payload_hash: createHash("sha256").update(JSON.stringify(edited)).digest("hex"),
    }, now(), { target_workflow_id: execution.execution_workflow_id, release: output.release });
    if (!result.ok) return http.json({ error: result.error.detail, code: result.error.kind }, 409);
    const revision = result.value.artifact;
    await dependencies.dispatch_notifications();
    return http.json({ artifact_id: revision.id }, 201);
  });
  app.get("/artifacts/:id/review_items", async (http) => {
    const artifact = await dependencies.artifacts.find_by_id(http.req.param("id") as ArtifactId);
    if (!artifact) return http.json({ error: "artifact not found" }, 404);
    if (!dependencies.policy_for_artifact_type(artifact.artifact_type)?.review_items) return http.json({ error: `artifact type '${artifact.artifact_type}' does not support 'review_items'` }, 400);
    return http.json(await dependencies.collaboration.list_review_items(artifact.chain_id));
  });
  app.post("/artifacts/:id/review_items", async (http) => {
    const artifact = await dependencies.artifacts.find_by_id(http.req.param("id") as ArtifactId);
    if (!artifact) return http.json({ error: "artifact not found" }, 404);
    if (!isMutable(artifact)) return http.json({ error: "artifact revision is not current", code: artifact.lifecycle.kind }, 409);
    if (!dependencies.policy_for_artifact_type(artifact.artifact_type)?.review_items) return http.json({ error: `artifact type '${artifact.artifact_type}' does not support 'review_items'` }, 400);
    const body = await objectBody(http.req.raw); const anchor = nonempty(body?.anchor); const claim = nonempty(body?.claim); const reality = nonempty(body?.reality);
    if (!anchor || !claim || !reality) return http.json({ error: "anchor, claim, and reality are required" }, 400);
    const item: ReviewItem = { id: newId() as ReviewItemId, artifact_id: artifact.chain_id, revision_id: artifact.id, anchor, claim, reality, status: "open", resolution: null, created_at: now() };
    await dependencies.collaboration.insert_review_item(item); return http.json(item, 201);
  });
  app.patch("/review_items/:id", async (http) => {
    const id = http.req.param("id") as ReviewItemId; const existingItem = await dependencies.collaboration.find_review_item(id); if (!existingItem) return http.json({ error: "review item not found" }, 404);
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
