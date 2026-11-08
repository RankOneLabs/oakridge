// Collaboration through v2 revision and thread routes.

import type { CollabThread, ReviewItem, PostThreadRequest, PostMessageRequest, PostAtomEditRequest, PostReviewItemRequest, PatchReviewItemRequest } from "./collab-types";
import type { OperatorCollaborationMessageRow, OperatorCollaborationThreadRow, OperatorReviewItemRow } from "./operator-contracts/domain/delegated-session";
import type { OperatorIngressResponse } from "./operator-contracts/http/ingress";
import type { OperatorArtifactDetail } from "./operator-contracts/projections/artifact-view";
import type { OperatorCollaborationThreadView } from "./operator-contracts/projections/collaboration-view";
import { artifactKeyFromComposite, replaceJsonPointer, unwrap as unwrapAdapter, type CompositeId } from "./adapters/core";
import { parseArtifactDetail } from "./adapters/parse";
import { committed, oakridgeGet, oakridgePost, oakridgePutBody, unitPath } from "./client-http";

interface CollabClientContext {
  resolveArtifactId: (id: string) => Promise<CompositeId>;
  invalidateCachedRunUnits: (runId: string | null) => void;
}

interface RevisionLocation { readonly runId: string; readonly unitId: string; readonly artifactKey: string; readonly revisionId: string; readonly detail: OperatorArtifactDetail }

const threadsPath = (location: RevisionLocation): string =>
  `${unitPath(location.runId, location.unitId)}/revisions/${encodeURIComponent(location.revisionId)}/threads`;

const reviewItemView = (item: OperatorReviewItemRow, artifactId: string, anchor: string): ReviewItem => ({
  id: item.id, artifact_id: artifactId, revision_id: item.artifact_revision_id, anchor,
  claim: item.body.title, reality: item.body.detail,
  status: item.body.status === "resolved" || item.body.status === "waived" ? item.body.status : "open",
  resolution: null, created_at: item.created_at,
});

export function createCollabClient({ resolveArtifactId, invalidateCachedRunUnits }: CollabClientContext) {
  const threadLocation = new Map<string, { readonly runId: string; readonly unitId: string }>();

  async function revisionLocation(artifactId: string): Promise<RevisionLocation> {
    const parsed = await resolveArtifactId(artifactId);
    const artifactKey = artifactKeyFromComposite(parsed.name);
    const path = `${unitPath(parsed.runId, parsed.unitId)}/artifacts/${encodeURIComponent(artifactKey)}`;
    const detail = unwrapAdapter(path, parseArtifactDetail(await oakridgeGet<unknown>(path)));
    const revisionId = parsed.name.includes(":") ? parsed.name.slice(artifactKey.length + 1) : detail.revisions.at(-1)?.id;
    if (!revisionId || !detail.revisions.some((revision) => revision.id === revisionId)) throw new Error(`oakridge ${path}: revision unavailable`);
    return { runId: parsed.runId, unitId: parsed.unitId, artifactKey, revisionId, detail };
  }

  const threadView = (thread: OperatorCollaborationThreadView, artifactId: string): CollabThread => {
    threadLocation.set(thread.id, { runId: thread.run_id, unitId: thread.unit_id });
    return { id: thread.id, artifact_id: artifactId, revision_id: thread.artifact_revision_id,
      anchor: thread.context.anchor, status: "open", created_at: thread.created_at,
      messages: thread.messages.map((message) => ({ id: message.id, thread_id: message.thread_id,
        body: message.body.text, author: message.body.author, created_at: message.created_at })) };
  };

  async function fetchThreads(artifactId: string): Promise<CollabThread[]> {
    const location = await revisionLocation(artifactId);
    const threads = await oakridgeGet<OperatorCollaborationThreadView[]>(threadsPath(location));
    return threads.map((thread) => threadView(thread, artifactId));
  }

  async function postThread(artifactId: string, req: PostThreadRequest): Promise<{ thread_id: string; message_id: string }> {
    const location = await revisionLocation(artifactId);
    const thread = await oakridgePost<OperatorCollaborationThreadRow>(threadsPath(location),
      { request_key: crypto.randomUUID(), title: req.body || "Discussion", anchor: req.anchor ?? null });
    threadLocation.set(thread.id, { runId: location.runId, unitId: location.unitId });
    const message = await postMessage(thread.id, { body: req.body, author: req.author });
    return { thread_id: thread.id, message_id: message.message_id };
  }

  async function postMessage(threadId: string, req: PostMessageRequest): Promise<{ message_id: string }> {
    const location = threadLocation.get(threadId);
    if (!location) throw new Error(`oakridge thread ${threadId}: load its artifact before posting`);
    const path = `${unitPath(location.runId, location.unitId)}/threads/${encodeURIComponent(threadId)}/messages`;
    const response = await oakridgePost<{ readonly message: OperatorCollaborationMessageRow }>(path,
      { request_key: crypto.randomUUID(), text: req.body });
    return { message_id: response.message.id };
  }

  function pingThread(threadId: string, _idempotencyKey: string): Promise<{ ok: boolean }> {
    return Promise.reject(new Error(`oakridge thread ${threadId}: v2 has no ping operation`));
  }

  function resolveThread(threadId: string): Promise<{ thread_id: string; status: string }> {
    return Promise.reject(new Error(`oakridge thread ${threadId}: v2 has no resolution operation`));
  }

  async function postAtomEdit(revisionId: string, req: PostAtomEditRequest): Promise<{ artifact_id: string }> {
    const location = await revisionLocation(revisionId);
    const revision = location.detail.revisions.find((candidate) => candidate.id === location.revisionId);
    if (!revision) throw new Error(`oakridge ${revisionId}: revision unavailable`);
    const body = unwrapAdapter(revisionId, replaceJsonPointer(revision.body, req.anchor, req.prev_value, req.new_value));
    return publishArtifactRevision(location, body);
  }

  /** Publish a whole successor body for edits an anchor replacement cannot express. */
  async function putArtifactRevisionBody(revisionId: string, body: unknown): Promise<{ artifact_id: string }> {
    return publishArtifactRevision(await revisionLocation(revisionId), body);
  }

  async function publishArtifactRevision(location: RevisionLocation, body: unknown): Promise<{ artifact_id: string }> {
    const revision = location.detail.revisions.find((candidate) => candidate.id === location.revisionId);
    if (!revision) throw new Error(`oakridge ${location.revisionId}: revision unavailable`);
    const path = `${unitPath(location.runId, location.unitId)}/artifacts/${encodeURIComponent(location.artifactKey)}`;
    committed(await oakridgePutBody<OperatorIngressResponse>(path, { request_id: crypto.randomUUID(), body,
      predecessor: location.revisionId, subject: revision.subject_id }), path);
    invalidateCachedRunUnits(location.runId);
    return { artifact_id: location.revisionId };
  }

  async function fetchReviewItems(artifactId: string): Promise<ReviewItem[]> {
    const location = await revisionLocation(artifactId);
    const threads = await oakridgeGet<OperatorCollaborationThreadView[]>(threadsPath(location));
    return threads.flatMap((thread) => thread.review_items.map((item) => reviewItemView(item, artifactId, thread.context.anchor ?? "")));
  }

  async function postReviewItem(artifactId: string, req: PostReviewItemRequest): Promise<ReviewItem> {
    const location = await revisionLocation(artifactId);
    const thread = await oakridgePost<OperatorCollaborationThreadRow>(threadsPath(location),
      { request_key: crypto.randomUUID(), title: req.claim, anchor: req.anchor });
    const path = `${unitPath(location.runId, location.unitId)}/threads/${encodeURIComponent(thread.id)}/review-items`;
    const item = await oakridgePost<OperatorReviewItemRow>(path,
      { request_key: crypto.randomUUID(), title: req.claim, detail: req.reality, status: "open" });
    return reviewItemView(item, artifactId, req.anchor);
  }

  function patchReviewItem(reviewItemId: string, _req: PatchReviewItemRequest): Promise<ReviewItem> {
    return Promise.reject(new Error(`oakridge review item ${reviewItemId}: v2 has no update operation`));
  }

  return { fetchThreads, postThread, postMessage, pingThread, resolveThread, postAtomEdit, putArtifactRevisionBody, fetchReviewItems, postReviewItem, patchReviewItem };
}
