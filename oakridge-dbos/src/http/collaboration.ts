import { createHash, randomUUID } from "node:crypto";

import { Hono } from "hono";

import { renderCollaborationPingPrompt, validateCollaborationPingRequestId, type CollaborationMessage, type CollaborationPingAccepted, type CollaborationThread, type MessageId, type ReviewItem, type ReviewItemId, type ReviewItemStatus, type ThreadId, type ThreadStatus } from "../domain/collaboration";
import { parseUuidId, isJsonValue, type ArtifactId, type JsonValue, type WorkflowRunId, type WorkOrderId } from "../domain/primitives";
import { decodeJsonPointerSegment } from "../domain/json-pointer";
import { workOrderIdOfArtifact, type ArtifactRevision } from "../domain/artifacts";
import type { ArtifactRevisionRepository, CollaborationRepository, RunRecordRepository } from "../storage/repositories";
import { workOrderCapabilityHash } from "../runtime/resolve-work-order";

export interface ArtifactCollaborationPolicy {
  readonly commentable: boolean;
  readonly review_items: boolean;
  readonly atom_editable?: boolean;
  readonly anchor_schema?: readonly string[] | null;
  readonly validate_body?: (body: JsonValue) => boolean;
}
export interface CollaborationHttpDependencies {
  readonly artifacts: ArtifactRevisionRepository;
  readonly collaboration: CollaborationRepository;
  readonly policy_for_artifact_type: (artifact_type: string) => ArtifactCollaborationPolicy | null;
  readonly records: Pick<RunRecordRepository, "find_work_order_attachment" | "publish_artifact" | "load_work_order_capability_seed">;
  readonly ping_thread: (input: import("../domain/collaboration").CollaborationPingRequest) => Promise<CollaborationPingAccepted>;
  /** Wakes the run's root workflow sooner than its bounded recheck; absent is fine — the recheck still happens. */
  readonly send_run_wake?: (run_id: WorkflowRunId, idempotency_key: string) => Promise<void>;
  readonly now?: () => string;
  readonly new_id?: () => string;
}

const objectBody = async (request: Request): Promise<Record<string, unknown> | null> => {
  try { const value: unknown = await request.json(); return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; }
  catch { return null; }
};
const nonempty = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;
const anchorAllowed = (anchor: string, schema: readonly string[]): boolean => schema.some((prefix) => anchor === prefix || anchor.startsWith(`${prefix}/`));
const editJsonPointer = (body: JsonValue, pointer: string, previous: JsonValue, replacement: JsonValue): JsonValue | null => {
  if (!pointer.startsWith("/") || pointer === "/") return null;
  const clone = structuredClone(body) as JsonValue;
  const segments = pointer.slice(1).split("/").map(decodeJsonPointerSegment);
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

/**
 * An operator-driven edit carries no per-request capability header, and
 * `publish_artifact` requires a hash matching the stored `capability_hash`
 * whoever the caller is. The seed is one durable secret, so the value
 * `resolveWorkOrder` minted for this work order is reproducible here — through
 * the same transform, not a second copy of it.
 */
const capabilityHashForWorkOrder = async (
  records: Pick<RunRecordRepository, "load_work_order_capability_seed">,
  work_order_id: WorkOrderId,
): Promise<string> => workOrderCapabilityHash(await records.load_work_order_capability_seed(), work_order_id);

export const createCollaborationApp = (dependencies: CollaborationHttpDependencies): Hono => {
  const app = new Hono();
  const now = () => (dependencies.now ?? (() => new Date().toISOString()))();
  const newId = () => (dependencies.new_id ?? randomUUID)();
  const isMutable = (artifact: ArtifactRevision): boolean => artifact.lifecycle.kind === "current";

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
    const requestIdResult = validateCollaborationPingRequestId(http.req.header("idempotency-key") ?? randomUUID());
    if (requestIdResult.kind === "invalid") return http.json({ error: requestIdResult.detail }, 400);
    const requestId = requestIdResult.request_id;
    const workOrderId = workOrderIdOfArtifact(threadRevision);
    if (!workOrderId) return http.json({ error: "thread artifact was not produced by a work order" }, 409);
    const attachment = await dependencies.records.find_work_order_attachment(workOrderId);
    if (!attachment || attachment.external_reference === null) return http.json({ error: "thread executor is not attached" }, 409);
    const accepted = await dependencies.ping_thread({
      thread_id: threadId, request_id: requestId, execution_id: threadRevision.execution_id,
      executor_type: attachment.executor_type, external_reference: attachment.external_reference,
      prompt: renderCollaborationPingPrompt(fullThread),
    });
    return http.json({ ok: true, ...accepted }, 202);
  });
  app.post("/artifacts/:id/edits", async (http) => {
    const artifactId = parseUuidId<ArtifactId>(http.req.param("id"));
    const artifact = artifactId && await dependencies.artifacts.find_by_id(artifactId);
    if (!artifact) return http.json({ error: "artifact not found" }, 404);
    if (!isMutable(artifact)) return http.json({ error: "artifact revision is not current", code: artifact.lifecycle.kind }, 409);
    const policy = dependencies.policy_for_artifact_type(artifact.artifact_type);
    if (!policy?.atom_editable) return http.json({ error: `artifact type '${artifact.artifact_type}' does not support 'atom_editable'` }, 400);
    const body = await objectBody(http.req.raw); const anchor = nonempty(body?.anchor); const author = nonempty(body?.author);
    if (!anchor || !author || !isJsonValue(body?.prev_value) || !isJsonValue(body?.new_value)) return http.json({ error: "anchor, author, prev_value, and new_value are required" }, 400);
    if (policy.anchor_schema && !anchorAllowed(anchor, policy.anchor_schema)) return http.json({ error: `anchor '${anchor}' is not in the artifact anchor schema` }, 400);
    const current = await dependencies.artifacts.find_current(artifact);
    if (!current || current.id !== artifact.id) return http.json({ error: "concurrent edit: artifact revision is stale" }, 409);
    const edited = editJsonPointer(artifact.body, anchor, body.prev_value, body.new_value);
    if (!edited) return http.json({ error: `prev_value mismatch or anchor '${anchor}' was not found` }, 409);
    if (policy.validate_body && !policy.validate_body(edited)) return http.json({ error: "edited artifact body failed type validation" }, 400);
    const workOrderId = workOrderIdOfArtifact(artifact);
    if (!workOrderId) return http.json({ error: "thread artifact was not produced by a work order" }, 409);
    const payload = JSON.stringify({ anchor, prev_value: body.prev_value, new_value: body.new_value, author });
    const payloadHash = createHash("sha256").update(payload).digest("hex");
    const capabilityHash = await capabilityHashForWorkOrder(dependencies.records, workOrderId);
    const result = await dependencies.records.publish_artifact({
      artifact_id: newId() as ArtifactId, work_order_id: workOrderId, capability_hash: capabilityHash,
      output_name: artifact.output_name, collection_key: artifact.collection_key ?? null, body: edited,
      idempotency_key: http.req.header("idempotency-key")?.trim() || `edit:${payloadHash}`,
      payload_hash: createHash("sha256").update(JSON.stringify(edited)).digest("hex"),
      published_at: now(),
    });
    if (result.kind !== "published" && result.kind !== "pending" && result.kind !== "already_applied") {
      return http.json({ error: result.detail, code: result.kind }, 409);
    }
    await dependencies.send_run_wake?.(result.run_id, `edit:${result.artifact_id}`).catch(() => undefined);
    const revision = await dependencies.artifacts.find_by_id(result.artifact_id);
    return http.json({ artifact_id: revision?.id ?? result.artifact_id }, 201);
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
