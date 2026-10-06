import { installSelectedEvidenceApi } from "./selected-evidence";
import { installSelectedPublicationApi } from "./selected-publication";
import type { Hono } from "hono";
import type { CoreClient } from "../core-client/client";
import { selectMutationIdentity, type MutationInput, type MutationService } from "../storage/mutation-service";
import { findReceipt } from "../storage/receipts";
import type { RunId, ScopeId } from "../storage/schema-records";
import type { TransactionalSqlExecutor } from "../storage/sql-executor";
import { readScopeView, readRunView, readInbox } from "../storage/projection-reader";
import { readPinnedDefinition } from "./definition-inspection";
import { readScopeDiagnostics, readScopeHistory } from "./diagnostics";
import { MAX_PUBLICATION_VALUE_BYTES, parsePublication, publicationValueBytes } from "./publication";
import { commandStatus, ConflictError, InternalFaultError, InvalidPayloadError, MalformedRequestError, MissingEntityError, PendingWork, parseScopeCommand, submitScopeCommand, type CommandError, type CommandResult } from "./scope-commands";

export interface DefinitionApiDependencies { readonly db: TransactionalSqlExecutor; readonly core: CoreClient; readonly mutations: MutationService; readonly wake: (run_id: RunId) => Promise<void> }
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
  app.get("/api/inbox", async () => { try { return Response.json(await readInbox(deps.db)); } catch (cause) { return fault(cause); } });
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
        ingress_id: parsed.request_id, trigger: parsed.trigger, operator_version: parsed.expected_scope_version, outputs: [parsed.output] };
      const prior = await findReceipt(deps.db, selectMutationIdentity(input));
      if (prior.kind === "replay") return response({ ok: true, value: new PendingWork(parsed.request_id, prior.receipt.transition_id, prior.receipt.scope_version) });
      if (prior.kind === "conflict") return response({ ok: false, error: new ConflictError("request ID reused with different publication content") });
      const view = await readScopeView(deps.db, input.scope_id);
      if (!view || view.run_id !== input.run_id) return response({ ok: false, error: new MissingEntityError("scope not found in run") });
      if (view.cursor.scope_version !== parsed.expected_scope_version) return response({ ok: false, error: new ConflictError("scope version changed") });
      const pinned = await readPinnedDefinition(deps.db, view.run_id);
      const output = pinned?.source.scopes.find((scope) => scope.key === view.scope_key)?.outputs.find((item) => item.key === parsed.output.output_key);
      if (!output || parsed.output.body.schema !== output.schema || (output.collection_key === null && parsed.output.collection_key !== ""))
        return response({ ok: false, error: new InvalidPayloadError("output does not match pinned definition") });
      if (!view.outputs.some((slot) => slot.output_key === parsed.output.output_key) && parsed.output.expected_slot_version !== null)
        return response({ ok: false, error: new ConflictError("output slot changed") });
      const result = await deps.mutations.decide(input);
      if (!result.ok) return response({ ok: false, error: new InternalFaultError(result.error.detail) });
      if (result.value.kind === "Conflict") return response({ ok: false, error: new ConflictError(result.value.detail) });
      if (result.value.kind === "Rejected") return response({ ok: false, error: new InvalidPayloadError(result.value.detail) });
      if (result.value.kind === "snapshot_too_large") return Response.json(result.value, { status: 413 });
      void deps.wake(c.req.param("run_id") as RunId).catch(() => undefined);
      return Response.json({ kind: "accepted_pending", request_id: parsed.request_id, ...result.value.receipt }, { status: 202 });
    } catch (cause) { return fault(cause); }
  });
}
