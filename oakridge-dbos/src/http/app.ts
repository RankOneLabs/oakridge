import { installProjectApi } from "./projects";
import { collaborationHandlers } from "./collaboration";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { CoreClient } from "../core-client/client";
import type { MutationService } from "../storage/mutation-service";
import type { RunId, UnitId } from "../storage/schema-records";
import type { TransactionalSqlExecutor } from "../storage/sql-executor";
import { readUnitView, readRunView, readInbox } from "../storage/projection-reader";
import { listDefinitions, readDefinition, readPinnedDefinition } from "./definition-inspection";
import { listPromptCatalog } from "../../../workflow-config/src/prompt-catalog";
import type { Workflow } from "../core-client/core-types";
import { readUnitDiagnostics, readUnitHistory } from "./diagnostics";
import type { RunPage } from "../projections/run-view";
import { readRunInspect } from "../projections/run-view";
import { commandStatus, InternalFaultError, InvalidPayloadError, MalformedRequestError, MissingEntityError, parseUnitDecision, submitUnitDecision, type CommandError, type CommandResult } from "./unit-decisions";
import { commitEvent } from "../storage/commit";
import { operatorWriterFromCredential } from "./control-auth";
import { createHash } from "node:crypto";

export interface DefinitionApiDependencies { readonly db: TransactionalSqlExecutor; readonly core: CoreClient; readonly mutations: MutationService; readonly wake: (run_id: RunId) => Promise<void> }
export const httpBodyLimit = () => bodyLimit({ maxSize: 1_048_576,
  onError: (context) => context.json({ kind: "oversized_payload", limit: 1_048_576 }, 413) });
interface PageQuery { readonly cursor: string | null; readonly limit: number }
const DEFAULT_PAGE_LIMIT = 100;
function pageQuery(limit_raw: string | undefined, cursor_raw: string | undefined): PageQuery | MalformedRequestError {
  const limit = limit_raw === undefined ? DEFAULT_PAGE_LIMIT : Number(limit_raw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > DEFAULT_PAGE_LIMIT)
    return new MalformedRequestError("invalid page limit");
  return { cursor: cursor_raw ?? null, limit };
}
interface RunPageCursor { readonly created_at: string; readonly id: string }
function runCursor(raw: string | null): RunPageCursor | null | MalformedRequestError {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!value || typeof value !== "object" || !("created_at" in value) || typeof value.created_at !== "string"
      || !Number.isFinite(Date.parse(value.created_at)) || !("id" in value) || typeof value.id !== "string" || !value.id)
      throw new Error("bad cursor");
    return { created_at: value.created_at, id: value.id };
  } catch { return new MalformedRequestError("invalid runs cursor"); }
}
function definitionCursor(raw: string | null): string | null | MalformedRequestError {
  if (raw === null) return null;
  try {
    const value = Buffer.from(raw, "base64url").toString("utf8");
    if (!/^[0-9a-f-]{36}$/i.test(value)) throw new Error("bad cursor");
    return value;
  } catch { return new MalformedRequestError("invalid definitions cursor"); }
}
/** `?archived=true` lists archived items; without it, the active ones. */
function archivedQuery(raw: string | undefined): boolean | MalformedRequestError {
  if (raw === undefined || raw === "false") return false;
  return raw === "true" ? true : new MalformedRequestError("archived must be true or false");
}
function errorResponse(error: CommandError): { readonly error: string; readonly code: CommandError["kind"]; readonly trace_id?: string } {
  return error instanceof InternalFaultError ? { error: "internal fault", code: error.kind, trace_id: error.trace_id } : { error: error.detail, code: error.kind };
}
function response(result: CommandResult): Response {
  return Response.json(result.ok ? result.value : errorResponse(result.error), { status: commandStatus(result) });
}
function fault(cause: unknown): Response { return response({ ok: false, error: new InternalFaultError(String(cause)) }); }
const AUTHORING_RETIRED = "v1 template authoring is retired; pin a compiled workflow instead";
async function body(request: Request): Promise<unknown | MalformedRequestError> {
  try { return await request.json(); } catch { return new MalformedRequestError("invalid JSON"); }
}
export function installDefinitionApi(app: Hono, deps: DefinitionApiDependencies): void {
  installProjectApi(app, deps);
  const collaboration = collaborationHandlers({ db: deps.db, kbbl_base_url: process.env.KBBL_BASE_URL ?? "http://127.0.0.1:8788" });
  app.get("/api/runs/:run_id/units/:unit_id/revisions/:revision_id/threads", collaboration.getThreads);
  app.post("/api/runs/:run_id/units/:unit_id/revisions/:revision_id/threads", collaboration.createThread);
  app.post("/api/runs/:run_id/units/:unit_id/threads/:thread_id/messages", collaboration.addMessage);
  app.post("/api/runs/:run_id/units/:unit_id/threads/:thread_id/review-items", collaboration.addReviewItem);
  app.get("/api/runs", async (c) => { try {
    const page = pageQuery(c.req.query("limit"), c.req.query("cursor"));
    if (page instanceof MalformedRequestError) return response({ ok: false, error: page });
    const after = runCursor(page.cursor);
    if (after instanceof MalformedRequestError) return response({ ok: false, error: after });
    const is_archived = archivedQuery(c.req.query("archived"));
    if (is_archived instanceof MalformedRequestError) return response({ ok: false, error: is_archived });
    const rows = await deps.db.query<{ run_id: RunId; created_at: Date }>(`SELECT id AS run_id,created_at FROM authority.run
      WHERE ($1::timestamptz IS NULL OR (created_at,id)<($1::timestamptz,$2::text)) AND (archived_at IS NOT NULL)=$4
      ORDER BY created_at DESC,id DESC LIMIT $3`, [after?.created_at ?? null, after?.id ?? null, page.limit + 1, is_archived]);
    const selected = rows.slice(0, page.limit);
    const runs = await Promise.all(selected.map((row) => readRunView(deps.db, row.run_id)));
    const last = selected.at(-1);
    const next_cursor = rows.length > page.limit && last ? Buffer.from(JSON.stringify({ created_at: new Date(last.created_at).toISOString(), id: last.run_id })).toString("base64url") : null;
    const run_page: RunPage = { items: runs.filter((run) => run !== null), next_cursor };
    return Response.json(run_page);
  } catch (cause) { return fault(cause); } });
  app.post("/api/runs", async (c) => {
    const raw = await body(c.req.raw);
    if (raw instanceof MalformedRequestError) return response({ ok: false, error: raw });
    if (!raw || typeof raw !== "object" || !("request_id" in raw) || typeof raw.request_id !== "string" || !raw.request_id
      || !("digest" in raw) || typeof raw.digest !== "string" || !("input" in raw))
      return c.json({ error: "request_id, digest and input are required" }, 400);
    const pinned = (await deps.db.query<{ id: string }>(
      "SELECT id FROM authority.definition_bundle WHERE digest=$1 AND archived_at IS NULL", [raw.digest]))[0];
    if (!pinned) return c.json({ error: "definition_not_found" }, 404);
    const run_id = "run-" + createHash("sha256").update(raw.request_id).digest("hex").slice(0, 32);
    const result = await commitEvent(deps.db, deps.core, { run_id, ingress_id: raw.request_id,
      definition_bundle_id: pinned.id, event: { kind: "launched", input: raw.input },
      writer: operatorWriterFromCredential(c.req.raw) });
    if (!result.ok) return c.json({ error: result.error.detail }, 500);
    if (result.value.kind === "conflict") return c.json(result.value, 409);
    if (result.value.kind === "rejected") return c.json(result.value, 422);
    if (result.value.kind === "committed") void deps.wake(run_id as RunId).catch(() => undefined);
    return c.json({ run_id, event_id: result.value.event_id }, result.value.kind === "committed" ? 201 : 200);
  });
  app.get("/api/definitions", async (c) => { try {
    const page = pageQuery(c.req.query("limit"), c.req.query("cursor"));
    if (page instanceof MalformedRequestError) return response({ ok: false, error: page });
    const after = definitionCursor(page.cursor);
    if (after instanceof MalformedRequestError) return response({ ok: false, error: after });
    const is_archived = archivedQuery(c.req.query("archived"));
    if (is_archived instanceof MalformedRequestError) return response({ ok: false, error: is_archived });
    return Response.json(await listDefinitions(deps.db, after, page.limit, is_archived));
  }
    catch (cause) { return fault(cause); } });
  app.get("/api/prompts", () => { try { return Response.json(listPromptCatalog()); }
    catch (cause) { return fault(cause); } });
  app.get("/api/definitions/:bundle_id", async (c) => { try {
    const definition = await readDefinition(deps.db, c.req.param("bundle_id"));
    return definition ? c.json(definition) : response({ ok: false, error: new MissingEntityError("definition not found") });
  } catch (cause) { return fault(cause); } });
  // The v1 template builder is retired with its authoring surface. The route
  // stays so the operator surface gets this reason rather than a 404; c3
  // reinstates it over the v2 compiler and the YAML workflows.
  app.post("/api/definitions/compile", () => Response.json(
    { error: AUTHORING_RETIRED, field_path: "authoring" }, { status: 422 }));
  app.post("/api/definitions", async (c) => {
    const source = await body(c.req.raw);
    if (source instanceof MalformedRequestError) return response({ ok: false, error: source });
    const authored = source && typeof source === "object" && "authoring" in source ? source.authoring : source;
    if (authored && typeof authored === "object" && "authoring_version" in authored)
      return Response.json({ error: AUTHORING_RETIRED, field_path: "authoring" }, { status: 422 });
    if (!source || typeof source !== "object" || !("workflow" in source) || typeof source.workflow !== "string")
      return response({ ok: false, error: new InvalidPayloadError("invalid workflow definition") });
    const pinned = await deps.mutations.pinDefinition({ workflow: source as Workflow });
    return pinned.ok ? Response.json(pinned.value, { status: 201 })
      : response({ ok: false, error: new InvalidPayloadError(pinned.error.detail) });
  });
  const archiveRun = (is_archived: boolean) => async (c: Context<{}, "/api/runs/:run_id/:action">) => { try {
    return await deps.mutations.setRunArchived(c.req.param("run_id") as RunId, is_archived)
      ? c.json({ run_id: c.req.param("run_id"), is_archived }) : response({ ok: false, error: new MissingEntityError("run not found") });
  } catch (cause) { return fault(cause); } };
  const archiveDefinition = (is_archived: boolean) => async (c: Context<{}, "/api/definitions/:bundle_id/:action">) => { try {
    return await deps.mutations.setDefinitionArchived(c.req.param("bundle_id"), is_archived)
      ? c.json({ bundle_id: c.req.param("bundle_id"), is_archived }) : response({ ok: false, error: new MissingEntityError("definition not found") });
  } catch (cause) { return fault(cause); } };
  app.post("/api/runs/:run_id/archive", archiveRun(true));
  app.post("/api/runs/:run_id/unarchive", archiveRun(false));
  app.post("/api/definitions/:bundle_id/archive", archiveDefinition(true));
  app.post("/api/definitions/:bundle_id/unarchive", archiveDefinition(false));
  app.get("/api/inbox", async (c) => {
    const limit_raw = c.req.query("limit");
    const limit = limit_raw === undefined ? undefined : Number(limit_raw);
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) return response({ ok: false, error: new MalformedRequestError("invalid inbox limit") });
    const cursor = c.req.query("cursor");
    if (cursor) {
      try {
        const parts: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (!Array.isArray(parts) || parts.length !== 2 || !parts.every((item) => typeof item === "string")) throw new Error("invalid cursor");
      } catch { return response({ ok: false, error: new MalformedRequestError("invalid inbox cursor") }); }
    }
    try { return Response.json(await readInbox(deps.db, { run_id: c.req.query("run_id") as RunId | undefined, cursor, limit })); }
    catch (cause) { return fault(cause); }
  });
  app.get("/api/runs/:run_id", async (c) => { try {
    const view = await readRunView(deps.db, c.req.param("run_id") as RunId);
    return view ? c.json(view) : response({ ok: false, error: new MissingEntityError("run not found") });
  } catch (cause) { return fault(cause); } });
  app.post("/api/runs/:run_id/cancel", async (c) => {
    const raw = await body(c.req.raw);
    if (raw instanceof MalformedRequestError) return response({ ok: false, error: raw });
    if (!raw || typeof raw !== "object" || !("request_id" in raw) || typeof raw.request_id !== "string" || !raw.request_id)
      return c.json({ error: "request_id is required" }, 400);
    const run_id = c.req.param("run_id");
    const result = await commitEvent(deps.db, deps.core, { run_id, ingress_id: raw.request_id,
      event: { kind: "cancel_requested" }, writer: operatorWriterFromCredential(c.req.raw) });
    if (!result.ok) return c.json({ error: result.error.detail }, 500);
    if (result.value.kind === "conflict") return c.json(result.value, 409);
    if (result.value.kind === "rejected") return c.json(result.value, 422);
    if (result.value.kind === "committed") void deps.wake(run_id as RunId).catch(() => undefined);
    return c.json({ run_id, event_id: result.value.event_id }, result.value.kind === "committed" ? 201 : 200);
  });
  app.post("/api/runs/:run_id/units/:unit_id/workers/:worker/retry", async (c) => {
    const raw = await body(c.req.raw);
    if (raw instanceof MalformedRequestError) return response({ ok: false, error: raw });
    if (!raw || typeof raw !== "object" || !("request_id" in raw) || typeof raw.request_id !== "string" || !raw.request_id)
      return c.json({ error: "request_id is required" }, 400);
    const run_id = c.req.param("run_id");
    const result = await commitEvent(deps.db, deps.core, { run_id, ingress_id: raw.request_id,
      event: { kind: "retry_requested", unit: c.req.param("unit_id"), worker: c.req.param("worker") },
      writer: operatorWriterFromCredential(c.req.raw) });
    if (!result.ok) return c.json({ error: result.error.detail }, 500);
    if (result.value.kind === "conflict") return c.json(result.value, 409);
    if (result.value.kind === "rejected") return c.json(result.value, 422);
    if (result.value.kind === "committed") void deps.wake(run_id as RunId).catch(() => undefined);
    return c.json({ run_id, event_id: result.value.event_id }, result.value.kind === "committed" ? 201 : 200);
  });
  app.get("/api/runs/:run_id/inspect", async (c) => { try {
    const inspect = await readRunInspect(deps.db, c.req.param("run_id"));
    return inspect ? c.json(inspect) : c.json({ error: "run_not_found" }, 404);
  } catch (cause) { return fault(cause); } });
  app.get("/api/runs/:run_id/definition", async (c) => { try {
    const pinned = await readPinnedDefinition(deps.db, c.req.param("run_id"));
    return pinned ? c.json(pinned) : response({ ok: false, error: new MissingEntityError("run not found") });
  } catch (cause) { return fault(cause); } });
  app.get("/api/runs/:run_id/units/:unit_id", async (c) => { try {
    const view = await readUnitView(deps.db, c.req.param("run_id") as RunId, c.req.param("unit_id") as UnitId);
    return view ? c.json(view) : response({ ok: false, error: new MissingEntityError("unit not found in run") });
  } catch (cause) { return fault(cause); } });
  app.get("/api/runs/:run_id/units/:unit_id/history", async (c) => { try {
    const history = await readUnitHistory(deps.db, c.req.param("run_id"), c.req.param("unit_id"));
    return history ? c.json(history) : response({ ok: false, error: new MissingEntityError("unit not found in run") });
  } catch (cause) { return fault(cause); } });
  app.get("/api/runs/:run_id/units/:unit_id/diagnostics", async (c) => { try {
    const diagnostics = await readUnitDiagnostics(deps.db, c.req.param("run_id"), c.req.param("unit_id"));
    return diagnostics ? c.json(diagnostics) : response({ ok: false, error: new MissingEntityError("unit not found in run") });
  } catch (cause) { return fault(cause); } });
  app.post("/api/runs/:run_id/units/:unit_id/decisions", async (c) => {
    const raw = await body(c.req.raw);
    if (raw instanceof MalformedRequestError) return response({ ok: false, error: raw });
    const parsed = parseUnitDecision(raw, c.req.param("unit_id") as UnitId);
    if (parsed instanceof MalformedRequestError) return response({ ok: false, error: parsed });
    const result = await submitUnitDecision(deps, c.req.param("run_id") as RunId, parsed, operatorWriterFromCredential(c.req.raw));
    if (result.ok) void deps.wake(c.req.param("run_id") as RunId).catch(() => undefined);
    return response(result);
  });
}
