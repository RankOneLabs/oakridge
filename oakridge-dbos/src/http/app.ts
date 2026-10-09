import { installSelectedEvidenceApi } from "./selected-evidence";
import { installSelectedPublicationApi } from "./selected-publication";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { CoreClient } from "../core-client/client";
import { selectMutationIdentity, type MutationInput, type MutationService } from "../storage/mutation-service";
import { findReceipt } from "../storage/receipts";
import type { RunId, ScopeId } from "../storage/schema-records";
import type { TransactionalSqlExecutor } from "../storage/sql-executor";
import { readScopeView, readRunView, readInbox } from "../storage/projection-reader";
import { listDefinitions, readPinnedDefinition } from "./definition-inspection";
import type { DefinitionBundle } from "../core-client/generated-contracts";
import { readScopeDiagnostics, readScopeHistory } from "./diagnostics";
import type { RunPage } from "../projections/run-view";
import { invocationInput } from "../effects/operations/selected-request";
import { MAX_PUBLICATION_VALUE_BYTES, parsePublication, publicationReceipt, publicationRevisionId, publicationValueBytes } from "./publication";
import { commandStatus, ConflictError, InternalFaultError, InvalidPayloadError, MalformedRequestError, MissingEntityError, parseScopeCommand, submitScopeCommand, type CommandError, type CommandResult } from "./scope-commands";
import { findHeldSession } from "../effects/intents";

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
function errorResponse(error: CommandError): { readonly error: string; readonly detail: string; readonly trace_id?: string } {
  return error instanceof InternalFaultError ? { error: error.kind, detail: "internal fault", trace_id: error.trace_id } : { error: error.kind, detail: error.detail };
}
function response(result: CommandResult): Response {
  return Response.json(result.ok ? result.value : errorResponse(result.error), { status: commandStatus(result) });
}
function fault(cause: unknown): Response { return response({ ok: false, error: new InternalFaultError(String(cause)) }); }
async function body(request: Request): Promise<unknown | MalformedRequestError> {
  try { return await request.json(); } catch { return new MalformedRequestError("invalid JSON"); }
}
export function installDefinitionApi(app: Hono, deps: DefinitionApiDependencies): void {
  installSelectedPublicationApi(app, deps);
  installSelectedEvidenceApi(app, deps);
  app.get("/api/runs", async (c) => { try {
    const page = pageQuery(c.req.query("limit"), c.req.query("cursor"));
    if (page instanceof MalformedRequestError) return response({ ok: false, error: page });
    const after = runCursor(page.cursor);
    if (after instanceof MalformedRequestError) return response({ ok: false, error: after });
    const rows = await deps.db.query<{ run_id: RunId; created_at: Date }>(`SELECT id AS run_id,created_at FROM authority.run
      WHERE ($1::timestamptz IS NULL OR (created_at,id)<($1::timestamptz,$2::text))
      ORDER BY created_at DESC,id DESC LIMIT $3`, [after?.created_at ?? null, after?.id ?? null, page.limit + 1]);
    const selected = rows.slice(0, page.limit);
    const runs = await Promise.all(selected.map((row) => readRunView(deps.db, row.run_id)));
    const last = selected.at(-1);
    const next_cursor = rows.length > page.limit && last ? Buffer.from(JSON.stringify({ created_at: new Date(last.created_at).toISOString(), id: last.run_id })).toString("base64url") : null;
    const run_page: RunPage = { items: runs.filter((run) => run !== null), next_cursor };
    return Response.json(run_page);
  } catch (cause) { return fault(cause); } });
  app.get("/api/definitions", async (c) => { try {
    const page = pageQuery(c.req.query("limit"), c.req.query("cursor"));
    if (page instanceof MalformedRequestError) return response({ ok: false, error: page });
    const after = definitionCursor(page.cursor);
    if (after instanceof MalformedRequestError) return response({ ok: false, error: after });
    return Response.json(await listDefinitions(deps.db, after, page.limit));
  }
    catch (cause) { return fault(cause); } });
  app.post("/api/definitions", async (c) => {
    const source = await body(c.req.raw);
    if (source instanceof MalformedRequestError) return response({ ok: false, error: source });
    if (!source || typeof source !== "object" || !("key" in source) || typeof source.key !== "string")
      return response({ ok: false, error: new InvalidPayloadError("invalid definition bundle") });
    const pinned = await deps.mutations.pinDefinition({ bundle: source as DefinitionBundle });
    return pinned.ok ? Response.json(pinned.value, { status: 201 })
      : response({ ok: false, error: new InvalidPayloadError(pinned.error.detail) });
  });
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
  app.get("/api/session_holds/:sid", async (c) => { try {
    const held = await findHeldSession(deps.db, c.req.param("sid"));
    return Response.json(held ? { held: true, hold: held } : { held: false, hold: null });
  } catch (cause) { return fault(cause); } });
  app.get("/api/runs/:run_id", async (c) => { try {
    const view = await readRunView(deps.db, c.req.param("run_id") as RunId);
    return view ? c.json(view) : response({ ok: false, error: new MissingEntityError("run not found") });
  } catch (cause) { return fault(cause); } });
  app.get("/api/runs/:run_id/definition", async (c) => { try {
    const pinned = await readPinnedDefinition(deps.db, c.req.param("run_id"));
    return pinned ? c.json(pinned) : response({ ok: false, error: new MissingEntityError("run not found") });
  } catch (cause) { return fault(cause); } });
  app.get("/api/runs/:run_id/scopes/:scope_id", async (c) => { try {
    const view = await readScopeView(deps.db, c.req.param("scope_id") as ScopeId);
    return view && view.run_id === c.req.param("run_id") ? c.json(view) : response({ ok: false, error: new MissingEntityError("scope not found in run") });
  } catch (cause) { return fault(cause); } });
  app.get("/api/runs/:run_id/scopes/:scope_id/decision", async (c) => { try {
    const view = await readScopeView(deps.db, c.req.param("scope_id") as ScopeId);
    return view && view.run_id === c.req.param("run_id") ? c.json({ decision: view.decision, cursor: view.cursor }) : response({ ok: false, error: new MissingEntityError("scope not found in run") });
  } catch (cause) { return fault(cause); } });
  app.get("/api/runs/:run_id/scopes/:scope_id/history", async (c) => { try {
    const history = await readScopeHistory(deps.db, c.req.param("run_id"), c.req.param("scope_id"));
    return history ? c.json(history) : response({ ok: false, error: new MissingEntityError("scope not found in run") });
  } catch (cause) { return fault(cause); } });
  app.get("/api/runs/:run_id/scopes/:scope_id/diagnostics", async (c) => { try {
    const view = await readScopeView(deps.db, c.req.param("scope_id") as ScopeId);
    if (!view || view.run_id !== c.req.param("run_id")) return response({ ok: false, error: new MissingEntityError("scope not found in run") });
    return c.json(await readScopeDiagnostics(deps.db, view.scope_id));
  } catch (cause) { return fault(cause); } });
  app.post("/api/runs/:run_id/scopes/:scope_id/commands", async (c) => {
    const raw = await body(c.req.raw);
    if (raw instanceof MalformedRequestError) return response({ ok: false, error: raw });
    const parsed = parseScopeCommand(raw, c.req.param("scope_id") as ScopeId);
    if (parsed instanceof MalformedRequestError) return response({ ok: false, error: parsed });
    const result = await submitScopeCommand(deps, c.req.param("run_id") as RunId, parsed);
    if (result.ok) void deps.wake(c.req.param("run_id") as RunId).catch(() => undefined);
    return response(result);
  });
  app.post("/api/runs/:run_id/scopes/:scope_id/publications", async (c) => {
    const raw = await body(c.req.raw);
    if (raw instanceof MalformedRequestError) return response({ ok: false, error: raw });
    const parsed = parsePublication(raw, c.req.param("scope_id") as ScopeId);
    if (parsed instanceof MalformedRequestError) return response({ ok: false, error: parsed });
    const value_bytes = publicationValueBytes(parsed.output.body);
    if (value_bytes > MAX_PUBLICATION_VALUE_BYTES) return Response.json({ kind: "oversized_payload", bytes: value_bytes, limit: MAX_PUBLICATION_VALUE_BYTES }, { status: 413 });
    try {
      const input: MutationInput = { run_id: c.req.param("run_id") as RunId, scope_id: c.req.param("scope_id") as ScopeId,
        ingress_id: parsed.request_id, trigger: parsed.trigger, operator_version: parsed.expected_scope_version,
        outputs: [{ ...parsed.output, revision_id: publicationRevisionId(c.req.param("run_id"), c.req.param("scope_id"), parsed.request_id) }] };
      const prior = await findReceipt(deps.db, selectMutationIdentity(input));
      if (prior.kind === "replay") return Response.json(publicationReceipt(parsed.request_id, prior.receipt, input.outputs?.[0]?.revision_id ?? null), { status: 202 });
      if (prior.kind === "conflict") return response({ ok: false, error: new ConflictError("request ID reused with different publication content") });
      const view = await readScopeView(deps.db, input.scope_id);
      if (!view || view.run_id !== input.run_id) return response({ ok: false, error: new MissingEntityError("scope not found in run") });
      if (view.cursor.scope_version !== parsed.expected_scope_version) return response({ ok: false, error: new ConflictError("scope version changed") });
      const pinned = await readPinnedDefinition(deps.db, view.run_id);
      const declaration = pinned?.source.scopes.find((scope) => scope.key === view.scope_key);
      const output = declaration?.outputs.find((item) => item.key === parsed.output.output_key);
      if (!output || parsed.output.body.schema !== output.schema || output.publication_trigger !== parsed.trigger.key
        || (output.collection_key === null && parsed.output.collection_key !== ""))
        return response({ ok: false, error: new InvalidPayloadError("output does not match pinned definition") });
      if (!pinned) return response({ ok: false, error: new MissingEntityError("pinned definition not found") });
      const trigger_schema = declaration?.facts.find((fact) => fact.key === parsed.trigger.key)?.payload_schema
        ?? declaration?.commands.find((command) => command.key === parsed.trigger.key)?.payload_schema;
      if (!trigger_schema) return response({ ok: false, error: new InvalidPayloadError("publication trigger is undeclared") });
      const raw_output = invocationInput(parsed.output.body, pinned.source);
      const raw_trigger = invocationInput(parsed.trigger.payload, pinned.source);
      if (!raw_output.ok || !raw_trigger.ok) return response({ ok: false, error: new InvalidPayloadError("publication checked value is malformed") });
      const checked_output = await deps.core.request("validate_payload", { bundle: pinned.source, schema: output.schema, payload: raw_output.value });
      const checked_trigger = await deps.core.request("validate_payload", { bundle: pinned.source, schema: trigger_schema, payload: raw_trigger.value });
      if (!checked_output.ok || checked_output.value.kind !== "validated" || JSON.stringify(checked_output.value.value) !== JSON.stringify(parsed.output.body)
        || !checked_trigger.ok || checked_trigger.value.kind !== "validated" || JSON.stringify(checked_trigger.value.value) !== JSON.stringify(parsed.trigger.payload))
        return response({ ok: false, error: new InvalidPayloadError("publication does not match checked schema") });
      if (!view.outputs.some((slot) => slot.output_key === parsed.output.output_key) && parsed.output.expected_slot_version !== null)
        return response({ ok: false, error: new ConflictError("output slot changed") });
      const result = await deps.mutations.decide(input);
      if (!result.ok) return response({ ok: false, error: result.error.detail === "scope not found in run"
        ? new MissingEntityError(result.error.detail) : new InternalFaultError(result.error.detail) });
      if (result.value.kind === "Conflict") return response({ ok: false, error: new ConflictError(result.value.detail) });
      if (result.value.kind === "Rejected") return response({ ok: false, error: new InvalidPayloadError(result.value.detail) });
      if (result.value.kind === "snapshot_too_large") return Response.json(result.value, { status: 413 });
      void deps.wake(c.req.param("run_id") as RunId).catch(() => undefined);
      return Response.json(publicationReceipt(parsed.request_id, result.value.receipt, input.outputs?.[0]?.revision_id ?? null), { status: 202 });
    } catch (cause) { return fault(cause); }
  });
}
