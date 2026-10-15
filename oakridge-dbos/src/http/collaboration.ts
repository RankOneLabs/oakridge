import type { Context } from "hono";
import type { Database } from "../storage/database";
import { operatorWriterFromCredential } from "./control-auth";
import { ConflictError, errorResponse, InvalidPayloadError, MissingEntityError, requestBody, MalformedRequestError } from "./errors";
import { addCollaborationMessage, addReviewItem, collaborationRecordId, createCollaborationThread,
  readCollaborationThreads, type CollaborationWriteResult } from "../storage/collaboration-store";

export interface CollaborationApiDependencies { readonly db: Database }

const object = (value: unknown): value is { readonly [key: string]: unknown } =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const bounded = (value: unknown): value is string => nonempty(value) && value.length <= 300;
function param(c: Context, key: string): string {
  const value = c.req.param(key);
  if (!value) throw new Error(`missing route parameter ${key}`);
  return value;
}
/** A write that took: 201 when it wrote, 200 when it replayed. A refused one maps to its request error. */
function written<Value>(c: Context, result: CollaborationWriteResult<Value>, shape: (value: Value) => unknown = (value) => value): Response {
  switch (result.kind) {
    case "written": return c.json(shape(result.value), 201);
    case "replayed": return c.json(shape(result.value), 200);
    case "missing": return errorResponse(new MissingEntityError("thread, revision or unit not found"));
    case "superseded": return errorResponse(new ConflictError("the revision is superseded; its threads are read-only"));
    case "conflict": return errorResponse(new ConflictError("request key reused with different content"));
  }
}

export function collaborationHandlers(deps: CollaborationApiDependencies) {
  return {
  getThreads: async (c: Context) => c.json(await readCollaborationThreads(deps.db,
    { run_id: param(c, "run_id"), unit_id: param(c, "unit_id"), revision_id: param(c, "revision_id") })),
  createThread: async (c: Context) => {
    const raw = await requestBody(c.req.raw);
    if (raw instanceof MalformedRequestError) return errorResponse(raw);
    if (!object(raw) || !bounded(raw.request_key) || !nonempty(raw.title) || !(raw.anchor === null || typeof raw.anchor === "string"))
      return errorResponse(new InvalidPayloadError("request_key, title and anchor are required"));
    const run_id = param(c, "run_id"), unit_id = param(c, "unit_id"), revision_id = param(c, "revision_id");
    return written(c, await createCollaborationThread(deps.db, { id: `thread:${collaborationRecordId(revision_id, raw.request_key)}`,
      run_id, unit_id, revision_id, context: { title: raw.title, anchor: raw.anchor } }));
  },
  addMessage: async (c: Context) => {
    const raw = await requestBody(c.req.raw);
    if (raw instanceof MalformedRequestError) return errorResponse(raw);
    if (!object(raw) || !bounded(raw.request_key) || !nonempty(raw.text)) return errorResponse(new InvalidPayloadError("request_key and text are required"));
    const run_id = param(c, "run_id"), unit_id = param(c, "unit_id"), thread_id = param(c, "thread_id");
    // The author is whoever's credential passed control auth, as for every operator event; the body has no say in it.
    const author = operatorWriterFromCredential(c.req.raw).subject;
    return written(c, await addCollaborationMessage(deps.db, { id: `message:${collaborationRecordId(thread_id, raw.request_key)}`,
      run_id, unit_id, thread_id, body: { text: raw.text, author } }), (message) => ({ message }));
  },
  addReviewItem: async (c: Context) => {
    const raw = await requestBody(c.req.raw);
    if (raw instanceof MalformedRequestError) return errorResponse(raw);
    if (!object(raw) || !bounded(raw.request_key) || !bounded(raw.title) || typeof raw.detail !== "string" || !bounded(raw.status))
      return errorResponse(new InvalidPayloadError("request_key, title, detail and status are required"));
    const run_id = param(c, "run_id"), unit_id = param(c, "unit_id"), thread_id = param(c, "thread_id");
    return written(c, await addReviewItem(deps.db, { id: `review:${collaborationRecordId(thread_id, raw.request_key)}`,
      run_id, unit_id, thread_id, body: { title: raw.title, detail: raw.detail, status: raw.status } }));
  },
  };
}
