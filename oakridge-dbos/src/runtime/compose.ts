import { Hono } from "hono";
import type { DefinitionBundle, Trigger } from "../core-client/generated-contracts";
import { CoreClient } from "../core-client/client";
import { controlTokenMiddleware, selectControlPlaneAccess } from "../http/control-auth";
import { authorityRepositories } from "../storage/repositories";
import { createMutationService } from "../storage/mutation-service";
import { PgPostgresExecutor } from "../storage/sql-executor";
import type { RunId, ScopeId, ScopeInstanceRecord } from "../storage/schema-records";
import type { OutputPublication } from "../storage/commit";

export interface ProductionOptions { readonly database_url: string; readonly core_binary: string; readonly host: string; readonly control_token?: string }
export interface RunProjection { readonly run_id: RunId; readonly root_scope_id: ScopeId; readonly scope_key: string; readonly version: number; readonly is_terminal: boolean }
export interface ProductionComposition { readonly app: Hono; close(): Promise<void> }

function isBundle(value: unknown): value is DefinitionBundle {
  return !!value && typeof value === "object" && "root" in value && typeof value.root === "string" && "scopes" in value && Array.isArray(value.scopes) && "operations" in value && Array.isArray(value.operations);
}
function isTrigger(value: unknown): value is Trigger {
  return !!value && typeof value === "object" && "id" in value && typeof value.id === "string" && "key" in value && typeof value.key === "string" && "payload" in value;
}
function isOutputPublication(value: unknown): value is OutputPublication {
  return !!value && typeof value === "object" && "scope_id" in value && typeof value.scope_id === "string" && "output_key" in value && typeof value.output_key === "string" && "collection_key" in value && typeof value.collection_key === "string" && "body" in value && "predecessor_id" in value && "expected_slot_version" in value && "execution_id" in value;
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
  app.post("/runs/:run_id/scopes/:scope_id/decide", async (context) => {
    let body: unknown;
    try { body = await context.req.json(); } catch { return context.json({ error: "invalid JSON" }, 400); }
    if (!body || typeof body !== "object" || !("trigger" in body) || !isTrigger(body.trigger) || !("ingress_id" in body) || typeof body.ingress_id !== "string") return context.json({ error: "invalid ingress" }, 400);
    const operator_version = "operator_version" in body && typeof body.operator_version === "number" ? body.operator_version : null;
    const outputs = "outputs" in body ? body.outputs : [];
    if (!Array.isArray(outputs) || !outputs.every(isOutputPublication)) return context.json({ error: "invalid output publication" }, 400);
    const result = await mutations.decide({ run_id: context.req.param("run_id") as RunId, scope_id: context.req.param("scope_id") as ScopeId, trigger: body.trigger, ingress_id: body.ingress_id, operator_version, outputs });
    return result.ok ? context.json(result.value) : context.json({ error: result.error }, 422);
  });
  return { app, async close() { core.close(); await db.close(); } };
}
