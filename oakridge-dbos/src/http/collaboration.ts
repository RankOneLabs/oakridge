import type { Context } from "hono";
import type { Database } from "../storage/database";
import { addCollaborationMessage, addReviewItem, collaborationRecordId, createCollaborationThread,
  readCollaborationThreads, readThreadRevision, recordCollaborationDelivery } from "../storage/collaboration-store";

export interface CollaborationApiDependencies { readonly db: Database }

/**
 * Why a ping reaches no session yet: delivering a message into the agent's
 * kbbl session belongs to the executor's agent path (rescue spec R3). The
 * message is kept and the failed delivery is recorded, so the thread shows it.
 */
const SESSION_DELIVERY_PENDING = "delivery into the agent's session is not ported to effect instructions yet";

const object = (value: unknown): value is { readonly [key: string]: unknown } =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 300;
async function json(request: Request): Promise<unknown> { try { return await request.json(); } catch { return null; } }
const status = (kind: "missing" | "superseded" | "conflict"): 404 | 409 => kind === "missing" ? 404 : 409;
function param(c: Context, key: string): string {
  const value = c.req.param(key);
  if (!value) throw new Error(`missing route parameter ${key}`);
  return value;
}

export function collaborationHandlers(deps: CollaborationApiDependencies) {
  return {
  getThreads: async (c: Context) => c.json(await readCollaborationThreads(deps.db,
    { run_id: param(c, "run_id"), unit_id: param(c, "unit_id"), revision_id: param(c, "revision_id") })),
  createThread: async (c: Context) => {
    const raw = await json(c.req.raw);
    if (!object(raw) || !nonempty(raw.request_key) || !nonempty(raw.title)
      || !(raw.anchor === null || typeof raw.anchor === "string")) return c.json({ error: "request_key, title and anchor are required" }, 400);
    const run_id = param(c, "run_id"), unit_id = param(c, "unit_id"), revision_id = param(c, "revision_id");
    const result = await createCollaborationThread(deps.db, { id: `thread:${collaborationRecordId(revision_id, raw.request_key)}`,
      run_id, unit_id, revision_id, context: { title: raw.title, anchor: raw.anchor } });
    return result.kind === "written" || result.kind === "replayed" ? c.json(result.value, result.kind === "written" ? 201 : 200)
      : c.json({ error: result.kind }, status(result.kind));
  },
  addMessage: async (c: Context) => {
    const raw = await json(c.req.raw);
    if (!object(raw) || !nonempty(raw.request_key) || !nonempty(raw.text) || !nonempty(raw.author)
      || (raw.ping !== undefined && typeof raw.ping !== "boolean")) return c.json({ error: "request_key, text and author are required" }, 400);
    const run_id = param(c, "run_id"), unit_id = param(c, "unit_id"), thread_id = param(c, "thread_id");
    const id = `message:${collaborationRecordId(thread_id, raw.request_key)}`;
    const result = await addCollaborationMessage(deps.db, { id, run_id, unit_id, thread_id,
      body: { text: raw.text, author: raw.author, ping: raw.ping === true } });
    if (result.kind !== "written" && result.kind !== "replayed") return c.json({ error: result.kind }, status(result.kind));
    if (!raw.ping) return c.json({ message: result.value }, result.kind === "written" ? 201 : 200);
    if (!await readThreadRevision(deps.db, { run_id, unit_id, thread_id })) return c.json({ error: "thread has no reviewed revision" }, 409);
    const delivery = await recordCollaborationDelivery(deps.db, { id: collaborationRecordId(thread_id, raw.request_key), run_id, unit_id,
      message_id: id, payload: { status: "failed", session_id: null, reason: SESSION_DELIVERY_PENDING, request_key: raw.request_key } });
    if (!delivery) return c.json({ error: "missing" }, 404);
    return c.json({ message: result.value, delivery }, result.kind === "written" ? 201 : 200);
  },
  addReviewItem: async (c: Context) => {
    const raw = await json(c.req.raw);
    if (!object(raw) || !nonempty(raw.request_key) || !nonempty(raw.title)
      || typeof raw.detail !== "string" || !nonempty(raw.status)) return c.json({ error: "request_key, title, detail and status are required" }, 400);
    const run_id = param(c, "run_id"), unit_id = param(c, "unit_id"), thread_id = param(c, "thread_id");
    const result = await addReviewItem(deps.db, { id: `review:${collaborationRecordId(thread_id, raw.request_key)}`,
      run_id, unit_id, thread_id, body: { title: raw.title, detail: raw.detail, status: raw.status } });
    return result.kind === "written" || result.kind === "replayed" ? c.json(result.value, result.kind === "written" ? 201 : 200)
      : c.json({ error: result.kind }, status(result.kind));
  },
  };
}
