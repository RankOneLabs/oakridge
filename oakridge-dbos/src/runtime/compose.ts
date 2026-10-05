import { Hono } from "hono";
import { decodeCoreResponse } from "../core-client/generated-contracts";
import type { DefinitionBundle, Trigger } from "../core-client/generated-contracts";
import { CoreClient } from "../core-client/client";
import { controlTokenMiddleware, selectControlPlaneAccess } from "../http/control-auth";
import { authorityRepositories } from "../storage/repositories";
import { createMutationService } from "../storage/mutation-service";
import { PgPostgresExecutor } from "../storage/sql-executor";
import type { RunId, ScopeId, ScopeInstanceRecord } from "../storage/schema-records";
import type { OutputPublication } from "../storage/commit";
import { dispatchSweep, type DispatchOptions } from "../effects/dispatch";
import type { EffectProvider } from "../effects/provider";
import { cancelRun, deleteRun } from "../effects/reconcile";

export interface ProductionOptions { readonly database_url: string; readonly core_binary: string; readonly host: string; readonly control_token?: string;
  readonly effect_provider?: EffectProvider; readonly dispatch?: Omit<DispatchOptions, "owner"> & { readonly sweep_ms: number } }
export interface RunProjection { readonly run_id: RunId; readonly root_scope_id: ScopeId; readonly scope_key: string; readonly version: number; readonly is_terminal: boolean }
export interface ProductionComposition { readonly app: Hono; close(): Promise<void> }

function isBundle(value: unknown): value is DefinitionBundle {
  return !!value && typeof value === "object" && "root" in value && typeof value.root === "string" && "scopes" in value && Array.isArray(value.scopes) && "operations" in value && Array.isArray(value.operations);
}
function isTrigger(value: unknown): value is Trigger {
  return !!value && typeof value === "object" && "id" in value && typeof value.id === "string" && "key" in value && typeof value.key === "string" && "payload" in value;
}
function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}
function isOutputPublication(value: unknown): value is OutputPublication {
  if (!value || typeof value !== "object") return false;
  if (!("scope_id" in value) || typeof value.scope_id !== "string" || !("output_key" in value) || typeof value.output_key !== "string" || !("collection_key" in value) || typeof value.collection_key !== "string") return false;
  if (!("predecessor_id" in value) || !isNullableString(value.predecessor_id) || !("execution_id" in value) || !isNullableString(value.execution_id)) return false;
  if (!("expected_slot_version" in value) || !(value.expected_slot_version === null || (typeof value.expected_slot_version === "number" && Number.isSafeInteger(value.expected_slot_version) && value.expected_slot_version >= 0))) return false;
  if (!("body" in value)) return false;
  return decodeCoreResponse({ version: 1, request_id: "output-validation", truncated: false, result: { status: "ok", value: { kind: "validated", value: value.body } } }) !== null;
}
export function createProductionComposition(options: ProductionOptions): ProductionComposition {
  const access = selectControlPlaneAccess({ host: options.host, token: options.control_token, allow_insecure_non_loopback: process.env.ALLOW_INSECURE_NON_LOOPBACK_CONTROL === "1" });
  if (access.kind === "refused") throw new Error(access.detail);
  const started = CoreClient.start({ binary: options.core_binary, deadlineMs: 10_000 });
  if (!started.ok) throw new Error(`workflow-cli could not start: ${started.error.detail.detail}`);
  const core = started.value;
  const db = PgPostgresExecutor.connect(options.database_url);
  const mutations = createMutationService(db, core);
  const repositories = authorityRepositories(db);
  const dispatchOptions: DispatchOptions = { owner: crypto.randomUUID(), concurrency: options.dispatch?.concurrency ?? 4,
    lease_ms: options.dispatch?.lease_ms ?? 60_000, provider_timeout_ms: options.dispatch?.provider_timeout_ms ?? 30_000 };
  let sweeping = false;
  const sweep = async (): Promise<void> => {
    if (!options.effect_provider || sweeping) return;
    sweeping = true;
    try { await dispatchSweep(db, options.effect_provider, dispatchOptions); }
    finally { sweeping = false; }
  };
  const timer = options.effect_provider ? setInterval(() => { void sweep().catch((error) => console.error("effect sweep failed", error)); }, options.dispatch?.sweep_ms ?? 5_000) : null;
  const app = new Hono();
  if (access.kind === "token_required") app.use("*", controlTokenMiddleware(access.token));
  app.get("/health", (context) => context.json({ status: "ok" }));
  app.post("/runs", async (context) => {
    let body: unknown;
    try { body = await context.req.json(); } catch { return context.json({ error: "invalid JSON" }, 400); }
    if (!body || typeof body !== "object" || !("bundle" in body) || !isBundle(body.bundle) || !("input" in body)) return context.json({ error: "invalid run request" }, 400);
    const result = await mutations.startRun({ bundle: body.bundle, available_operations: body.bundle.operations, input: body.input });
    return result.ok ? context.json(result.value, 201) : context.json({ error: result.error }, 422);
  });
  app.get("/runs/:run_id", async (context) => {
    const run_id = context.req.param("run_id") as RunId;
    const run = await repositories.run(run_id);
    if (!run) return context.json({ error: "run not found" }, 404);
    const roots = await db.query<ScopeInstanceRecord>("SELECT * FROM authority.scope_instance WHERE run_id=$1 AND parent_id IS NULL", [run_id]);
    const root = roots[0];
    if (!root) return context.json({ error: "root scope missing" }, 500);
    const projection: RunProjection = { run_id, root_scope_id: root.id as ScopeId, scope_key: root.scope_key, version: Number(root.version), is_terminal: root.is_terminal };
    return context.json(projection);
  });
  app.post("/runs/:run_id/cancel", async (context) => {
    let body: unknown;
    try { body = await context.req.json(); } catch { return context.json({ error: "invalid JSON" }, 400); }
    if (!body || typeof body !== "object" || !("kind" in body) || body.kind !== "cancel_run" || !("reason" in body) || typeof body.reason !== "string")
      return context.json({ error: "invalid cancellation command" }, 400);
    const result = await cancelRun(db, { kind: "cancel_run", run_id: context.req.param("run_id"), reason: body.reason });
    if (result.kind === "missing") return context.json({ error: "run not found" }, 404);
    void sweep().catch((error) => console.error("effect sweep failed", error));
    return context.json(result);
  });
  app.delete("/runs/:run_id", async (context) => {
    const result = await deleteRun(db, context.req.param("run_id"));
    if (result.kind === "missing") return context.json({ error: "run not found" }, 404);
    if (result.kind === "refused") return context.json(result, 409);
    return context.json(result);
  });
  app.post("/runs/:run_id/scopes/:scope_id/decide", async (context) => {
    let body: unknown;
    try { body = await context.req.json(); } catch { return context.json({ error: "invalid JSON" }, 400); }
    if (!body || typeof body !== "object" || !("trigger" in body) || !isTrigger(body.trigger) || !("ingress_id" in body) || typeof body.ingress_id !== "string") return context.json({ error: "invalid ingress" }, 400);
    const operator_version = "operator_version" in body && typeof body.operator_version === "number" ? body.operator_version : null;
    const outputs = "outputs" in body ? body.outputs : [];
    if (!Array.isArray(outputs) || !outputs.every(isOutputPublication)) return context.json({ error: "invalid output publication" }, 400);
    const result = await mutations.decide({ run_id: context.req.param("run_id") as RunId, scope_id: context.req.param("scope_id") as ScopeId, trigger: body.trigger, ingress_id: body.ingress_id, operator_version, outputs });
    if (result.ok && (result.value.kind === "Committed" || result.value.kind === "Replayed"))
      void sweep().catch((error) => console.error("effect sweep failed", error));
    return result.ok ? context.json(result.value) : context.json({ error: result.error }, 422);
  });
  return { app, async close() { if (timer) clearInterval(timer); core.close(); await db.close(); } };
}
