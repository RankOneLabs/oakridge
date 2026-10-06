import { DBOS } from "@dbos-inc/dbos-sdk";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { decodeCoreResponse } from "../core-client/generated-contracts";
import type { DefinitionBundle, Trigger } from "../core-client/generated-contracts";
import { CoreClient } from "../core-client/client";
import { controlTokenMiddleware, selectControlPlaneAccess } from "../http/control-auth";
import { installDefinitionApi } from "../http/app";
import { authorityRepositories } from "../storage/repositories";
import { createMutationService, cancelRun, deleteRun, type ScopeCancellationPayload } from "../storage/mutation-service";
import { PgPostgresExecutor } from "../storage/sql-executor";
import type { RunId, ScopeId, ScopeInstanceRecord } from "../storage/schema-records";
import type { OutputPublication } from "../storage/commit";
import type { EffectProvider } from "../effects/provider";
import type { PullRequestReader } from "./github-pull-requests";
import { createEffectProvider } from "../effects/operations/production-provider";
import { selectApplicationVersion } from "../workflows/engine-version";
import { DEFAULT_WORKFLOW_TIMING, ensureRunWorkflow, parkRunningWorkflows, registerWorkflowServices, resumeActiveRuns, wakeRun, type WorkflowTiming } from "../workflows/topology";

export interface ProductionOptions {
  readonly database_url: string; readonly core_binary: string; readonly host: string; readonly control_token?: string;
  readonly kbbl_base_url?: string; readonly pull_requests?: PullRequestReader; readonly effect_provider?: EffectProvider;
  /** Overrides for tests; production uses the defaults. */
  readonly timing?: Partial<WorkflowTiming>;
  /** Defaults to the engine digest, or `DBOS_APPLICATION_VERSION` when set. */
  readonly application_version?: string;
}
export interface RunProjection { readonly run_id: RunId; readonly root_scope_id: ScopeId; readonly scope_key: string; readonly version: number; readonly is_terminal: boolean }
export interface ProductionComposition { readonly app: Hono; readonly application_version: string; close(): Promise<void> }

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
function isCancellationPayloads(value: unknown): value is readonly ScopeCancellationPayload[] {
  return Array.isArray(value) && value.every((item: unknown) => !!item && typeof item === "object" && "scope_id" in item && typeof item.scope_id === "string" && "payload" in item);
}
/**
 * The production composition. DBOS is the runtime: it is configured and
 * launched here, every run gets a durable workflow, and effect intents are
 * carried by workflows that resume after a crash. Nothing here polls.
 */
export async function createProductionComposition(options: ProductionOptions): Promise<ProductionComposition> {
  const access = selectControlPlaneAccess({ host: options.host, token: options.control_token, allow_insecure_non_loopback: process.env.ALLOW_INSECURE_NON_LOOPBACK_CONTROL === "1" });
  if (access.kind === "refused") throw new Error(access.detail);
  const started = CoreClient.start({ binary: options.core_binary,
    args: ["--max-list-items", "10000", "--max-depth", "128", "--evaluation-budget", "1000000"], deadlineMs: 10_000 });
  if (!started.ok) throw new Error(`workflow-cli could not start: ${started.error.detail.detail}`);
  const core = started.value;
  const db = PgPostgresExecutor.connect(options.database_url);
  const mutations = createMutationService(db, core);
  const repositories = authorityRepositories(db);
  const provider = options.effect_provider ?? createEffectProvider({ db, core, kbbl_base_url: options.kbbl_base_url ?? process.env.KBBL_BASE_URL ?? "http://127.0.0.1:8788", pull_requests: options.pull_requests });
  const application_version = options.application_version ?? selectApplicationVersion();
  registerWorkflowServices({ db, core, mutations, provider, timing: { ...DEFAULT_WORKFLOW_TIMING, ...options.timing } });
  DBOS.setConfig({ name: "oakridge", systemDatabaseUrl: options.database_url, applicationVersion: application_version });
  try { await DBOS.launch(); } catch (error) { core.close(); await db.close(); throw error; }
  await resumeActiveRuns(db);
  const wake = (run_id: RunId): Promise<void> => wakeRun(run_id);
  const app = new Hono();
  app.use("*", bodyLimit({ maxSize: 1_048_576, onError: (context) => context.json({ kind: "oversized_payload", limit: 1_048_576 }, 413) }));
  if (access.kind === "token_required") app.use("*", controlTokenMiddleware(access.token));
  installDefinitionApi(app, { db, core, mutations, wake });
  app.get("/health", (context) => context.json({ status: "ok", application_version, core: core.health }));
  app.post("/runs", async (context) => {
    let body: unknown;
    try { body = await context.req.json(); } catch { return context.json({ error: "invalid JSON" }, 400); }
    if (!body || typeof body !== "object" || !("bundle" in body) || !isBundle(body.bundle) || !("input" in body)) return context.json({ error: "invalid run request" }, 400);
    const result = await mutations.startRun({ bundle: body.bundle, input: body.input });
    if (!result.ok) return context.json({ error: result.error }, 422);
    await ensureRunWorkflow(result.value.run_id);
    return context.json(result.value, 201);
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
    if ("payloads" in body && !isCancellationPayloads(body.payloads)) return context.json({ error: "invalid per-scope cancellation payloads" }, 400);
    const payloads = "payloads" in body && isCancellationPayloads(body.payloads) ? body.payloads : undefined;
    const result = await cancelRun(db, { kind: "cancel_run", run_id: context.req.param("run_id"), reason: body.reason, payloads }, core);
    if (result.kind === "rejected") return context.json(result, 422);
    if (result.kind === "missing") return context.json({ error: "run not found" }, 404);
    void wake(context.req.param("run_id") as RunId);
    return context.json(result);
  });
  app.delete("/runs/:run_id", async (context) => {
    const result = await deleteRun(db, context.req.param("run_id"));
    if (result.kind === "missing") return context.json({ error: "run not found" }, 404);
    if (result.kind === "refused") return context.json(result, 409);
    return context.json(result);
  });
  if (process.env.OAKRIDGE_ENABLE_RAW_INGRESS === "1") app.post("/runs/:run_id/scopes/:scope_id/decide", async (context) => {
    let body: unknown;
    try { body = await context.req.json(); } catch { return context.json({ error: "invalid JSON" }, 400); }
    if (!body || typeof body !== "object" || !("trigger" in body) || !isTrigger(body.trigger) || !("ingress_id" in body) || typeof body.ingress_id !== "string") return context.json({ error: "invalid ingress" }, 400);
    const operator_version = "operator_version" in body && typeof body.operator_version === "number" ? body.operator_version : null;
    const outputs = "outputs" in body ? body.outputs : [];
    if (!Array.isArray(outputs) || !outputs.every(isOutputPublication)) return context.json({ error: "invalid output publication" }, 400);
    const result = await mutations.decide({ run_id: context.req.param("run_id") as RunId, scope_id: context.req.param("scope_id") as ScopeId, trigger: body.trigger, ingress_id: body.ingress_id, operator_version, outputs });
    if (result.ok && (result.value.kind === "Committed" || result.value.kind === "Replayed"))
      void wake(context.req.param("run_id") as RunId);
    return result.ok ? context.json(result.value) : context.json({ error: result.error }, 422);
  });
  return { app, application_version, async close() { try { await parkRunningWorkflows(); await DBOS.shutdown(); } finally { core.close(); await db.close(); } } };
}
