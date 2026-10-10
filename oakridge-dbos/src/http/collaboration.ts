import { DBOS } from "@dbos-inc/dbos-sdk";
import type { Context } from "hono";
import { KbblExecutorAdapter } from "../adapters/kbbl";
import type { PinnedSessionStart } from "../adapters/kbbl";
import { readIntent } from "../effects/intents";
import { readCollaborationThreads } from "../projections/collaboration-view";
import { addCollaborationMessage, addReviewItem, collaborationRecordId, createCollaborationThread,
  findCollaborationDelivery, readRevisionCollaborationTarget, recordCollaborationDelivery,
  type CollaborationDeliveryRecord } from "../storage/collaboration";
import type { SqlExecutor, TransactionalSqlExecutor } from "../storage/sql-executor";

export interface CollaborationApiDependencies {
  readonly db: TransactionalSqlExecutor;
  readonly kbbl_base_url: string;
}
interface PingCommand { readonly run_id: string; readonly scope_id: string; readonly thread_id: string;
  readonly revision_id: string; readonly message_id: string; readonly request_key: string; readonly text: string }
export interface CollaborationDeliveryPort {
  ensure(request: PinnedSessionStart): Promise<{ readonly kind: "ok"; readonly session_id: string } | { readonly kind: "error"; readonly reason: string }>;
  send(session_id: string, delivery_key: string, text: string): Promise<void>;
}

async function pinnedSession(db: SqlExecutor, execution_id: string): Promise<PinnedSessionStart | null> {
  const intents = await db.query<{ readonly id: string }>(`SELECT id FROM authority.effect_intent
    WHERE execution_id=$1 AND payload->>'action'='start' ORDER BY updated_at DESC,id DESC LIMIT 1`, [execution_id]);
  if (!intents[0]) return null;
  const intent = await readIntent(db,intents[0].id);
  const request = intent?.payload.invocation.request;
  return request?.kind === "kbbl_session" && request.version === 1
    ? { session_key: request.session_key, body: intent!.payload.invocation.bytes } : null;
}

/** One DBOS step's IO body. The persisted record closes recovery after kbbl accepted the keyed turn. */
export async function deliverCollaborationPing(db: SqlExecutor, port: CollaborationDeliveryPort,
  command: PingCommand, read_pinned: (db: SqlExecutor, execution_id: string) => Promise<PinnedSessionStart | null> = pinnedSession): Promise<CollaborationDeliveryRecord> {
  const id = collaborationRecordId(command.thread_id,command.request_key);
  const prior = await findCollaborationDelivery(db,id);
  if (prior) return prior;
  const fail = (reason: string) => recordCollaborationDelivery(db, { id, run_id: command.run_id,
    scope_id: command.scope_id, message_id: command.message_id,
    payload: { status: "failed", session_id: null, reason, request_key: command.request_key } });
  const target = await readRevisionCollaborationTarget(db,command.run_id,command.revision_id);
  if (!target) return fail("no agent-produced revision exists in the reviewed revision chain");
  const request = await read_pinned(db,target.execution_id);
  if (!request) return fail(`no pinned resumable session exists for execution ${target.execution_id}`);
  const ensured = await port.ensure(request);
  if (ensured.kind === "error") return fail(`session ensure failed: ${ensured.reason}`);
  await port.send(ensured.session_id,id,command.text);
  return recordCollaborationDelivery(db, { id, run_id: command.run_id, scope_id: command.scope_id,
    message_id: command.message_id,
    payload: { status: "delivered", session_id: ensured.session_id, reason: null, request_key: command.request_key } });
}

export function kbblDeliveryPort(base_url: string): CollaborationDeliveryPort {
  const adapter = new KbblExecutorAdapter({ base_url, executor_function_identity: "collaboration" });
  return {
    async ensure(request) {
      const result = await adapter.ensure_collaboration(request);
      return result.kind === "acknowledged" && result.value.kind === "kbbl_session"
        ? { kind: "ok", session_id: result.value.session_id }
        : { kind: "error", reason: result.kind === "acknowledged" ? "kbbl returned no session" : result.detail };
    },
    async send(session_id, delivery_key, text) {
      await adapter.deliver_input("collaboration" as import("../domain/primitives").ExecutionId,
        delivery_key,text,{ kind: "kbbl_session", session_id });
    },
  };
}

let workflow_dependencies: CollaborationApiDependencies | null = null;
const deliverStep = DBOS.registerStep(async (command: PingCommand): Promise<CollaborationDeliveryRecord> => {
  if (!workflow_dependencies) throw new Error("collaboration delivery service is unavailable");
  return deliverCollaborationPing(workflow_dependencies.db,kbblDeliveryPort(workflow_dependencies.kbbl_base_url),command);
}, { name: "oakridgeCollaborationDelivery" });
const deliveryWorkflow = DBOS.registerWorkflow(async (command: PingCommand): Promise<CollaborationDeliveryRecord> => deliverStep(command),
  { name: "oakridgeCollaborationPing" });

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
  workflow_dependencies = deps;
  return {
  getThreads: async (c: Context) => {
    return c.json(await readCollaborationThreads(deps.db,param(c,"run_id"),param(c,"scope_id"),param(c,"revision_id")));
  },
  createThread: async (c: Context) => {
    const raw = await json(c.req.raw);
    if (!object(raw) || !nonempty(raw.request_key) || !nonempty(raw.title)
      || !(raw.anchor === null || typeof raw.anchor === "string")) return c.json({ error: "request_key, title and anchor are required" },400);
    const run_id = param(c,"run_id"), scope_id = param(c,"scope_id"), revision_id = param(c,"revision_id");
    const result = await createCollaborationThread(deps.db, { id: `thread:${collaborationRecordId(revision_id,raw.request_key)}`,
      run_id,scope_id,revision_id,context: { title: raw.title, anchor: raw.anchor } });
    return result.kind === "written" || result.kind === "replayed" ? c.json(result.value,result.kind === "written" ? 201 : 200)
      : c.json({ error: result.kind },status(result.kind));
  },
  addMessage: async (c: Context) => {
    const raw = await json(c.req.raw);
    if (!object(raw) || !nonempty(raw.request_key) || !nonempty(raw.text) || !nonempty(raw.author)
      || (raw.ping !== undefined && typeof raw.ping !== "boolean")) return c.json({ error: "request_key, text and author are required" },400);
    const run_id = param(c,"run_id"), scope_id = param(c,"scope_id"), thread_id = param(c,"thread_id");
    const id = `message:${collaborationRecordId(thread_id,raw.request_key)}`;
    const result = await addCollaborationMessage(deps.db,{ id,run_id,scope_id,thread_id,
      body: { text: raw.text, author: raw.author } });
    if (result.kind !== "written" && result.kind !== "replayed") return c.json({ error: result.kind },status(result.kind));
    if (!raw.ping) return c.json({ message: result.value },result.kind === "written" ? 201 : 200);
    const threads = await deps.db.query<{ readonly artifact_revision_id: string }>(
      "SELECT artifact_revision_id FROM authority.collaboration_thread WHERE id=$1 AND run_id=$2 AND scope_id=$3",[thread_id,run_id,scope_id]);
    const revision_id = threads[0]?.artifact_revision_id;
    if (!revision_id) return c.json({ error: "thread has no reviewed revision" },409);
    const command: PingCommand = { run_id,scope_id,thread_id,revision_id,message_id: id,request_key: raw.request_key,text: raw.text };
    const delivery = await (await DBOS.startWorkflow(deliveryWorkflow,
      { workflowID: `collaboration:${thread_id}:${raw.request_key}` })(command)).getResult();
    return c.json({ message: result.value, delivery },result.kind === "written" ? 201 : 200);
  },
  addReviewItem: async (c: Context) => {
    const raw = await json(c.req.raw);
    if (!object(raw) || !nonempty(raw.request_key) || !nonempty(raw.title)
      || typeof raw.detail !== "string" || !nonempty(raw.status)) return c.json({ error: "request_key, title, detail and status are required" },400);
    const run_id = param(c,"run_id"), scope_id = param(c,"scope_id"), thread_id = param(c,"thread_id");
    const result = await addReviewItem(deps.db,{ id: `review:${collaborationRecordId(thread_id,raw.request_key)}`,
      run_id,scope_id,thread_id,body: { title: raw.title, detail: raw.detail, status: raw.status } });
    return result.kind === "written" || result.kind === "replayed" ? c.json(result.value,result.kind === "written" ? 201 : 200)
      : c.json({ error: result.kind },status(result.kind));
  },
  };
}
