import { DBOS } from "@dbos-inc/dbos-sdk";
import { Hono } from "hono";
import { CORE_MAX_DEPTH, decodeCoreResponse } from "../core-client/generated-contracts";
import type { DefinitionBundle, Trigger } from "../core-client/generated-contracts";
import { CoreClient } from "../core-client/client";
import { activeRoutes } from "../http/routes";
import { controlTokenMiddleware, selectControlPlaneAccess } from "../http/control-auth";
import { browserWriteMiddleware, configuredBrowserWritePolicy } from "../http/browser-write-policy";
import { httpBodyLimit, installDefinitionApi } from "../http/app";
import { authorityRepositories } from "../storage/repositories";
import { createMutationService, cancelRun, deleteRun, type ScopeCancellationPayload, type ProviderCapabilities, type ProviderCapabilityInput } from "../storage/mutation-service";
import { PROVIDER_KINDS } from "../effects/provider-catalog";
import { PgPostgresExecutor } from "../storage/sql-executor";
import { verifyEffectEncryption } from "../storage/effect-secret";
import { redactingReadResponses } from "../projections/serialization-view";
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
  readonly provider_capabilities?: ProviderCapabilities;
  /** Overrides for tests; production uses the defaults. */
  readonly timing?: Partial<WorkflowTiming>;
  /** Defaults to the engine digest, or `DBOS_APPLICATION_VERSION` when set. */
  readonly application_version?: string;
}
export interface RunProjection { readonly run_id: RunId; readonly root_scope_id: ScopeId; readonly scope_key: string; readonly version: number; readonly is_terminal: boolean }
export interface ProductionComposition { readonly app: Hono; readonly application_version: string; readonly provider_capabilities: ProviderCapabilities; close(): Promise<void> }
interface ForgeRepository { readonly owner: string; readonly name: string }
/** Repository identity belongs to the GitHub contract; its enclosing fields belong to the bundle. */
function forgeRepositories({ bundle, input }: ProviderCapabilityInput): readonly ForgeRepository[] {
  const schemas = new Map(bundle.schemas.map((schema) => [schema.key, schema.shape]));
  const found = new Map<string, ForgeRepository>();
  function visit(schema_key: string, value: unknown, depth: number): void {
    if (depth > bundle.limits.max_depth || value === null || value === undefined) return;
    const shape = schemas.get(schema_key);
    if (!shape) return;
    if (shape.kind === "optional") { visit(shape.item, value, depth + 1); return; }
    if (shape.kind === "list") {
      if (Array.isArray(value)) value.forEach((item) => visit(shape.item, item, depth + 1));
      return;
    }
    if (typeof value !== "object" || Array.isArray(value)) return;
    const record = value as { readonly [key: string]: unknown };
    if (shape.kind === "union") {
      const variant = shape.variants.find((variant) => variant.key === record.kind);
      if (variant) visit(variant.schema, record.value, depth + 1);
      return;
    }
    if (shape.kind !== "record") return;
    if (shape.fields.some((field) => field.key === "owner") && shape.fields.some((field) => field.key === "name")
      && typeof record.owner === "string" && typeof record.name === "string") {
      const repository = { owner: record.owner, name: record.name };
      found.set(JSON.stringify(repository), repository);
    }
    shape.fields.forEach((field) => visit(field.schema, record[field.key], depth + 1));
    const dictionary = shape.dictionary;
    if (dictionary) Object.entries(record).filter(([key]) => !shape.fields.some((field) => field.key === key))
      .forEach(([, value]) => visit(dictionary, value, depth + 1));
  }
  const root = bundle.scopes.find((scope) => scope.key === bundle.root);
  if (root) visit(root.input_schema, input, 0);
  return [...found.values()];
}
export function githubProviderCapabilities(token: string, http: typeof fetch = fetch, kbbl_base_url = process.env.KBBL_BASE_URL ?? "http://127.0.0.1:8788"): ProviderCapabilities {
  return {
    async probe(kind) {
      if (kind === PROVIDER_KINDS.repository) {
        try {
          const git = Bun.spawnSync({ cmd: ["git", "--version"], stdout: "ignore", stderr: "ignore" });
          return git.exitCode === 0 ? { ok: true, value: true }
            : { ok: false, error: { operation: "probe_provider", entity_id: kind, detail: "git is unavailable" } };
        } catch (cause) { return { ok: false, error: { operation: "probe_provider", entity_id: kind, detail: String(cause) } }; }
      }
      if (kind === PROVIDER_KINDS.stub) return { ok: false, error: { operation: "probe_provider", entity_id: kind, detail: "stub has no live provider" } };
      if (kind === PROVIDER_KINDS.pull_request && !token) return { ok: false, error: { operation: "probe_provider", entity_id: kind, detail: "token is absent" } };
      const url = kind === PROVIDER_KINDS.session ? new URL("/", kbbl_base_url).href
        : kind === PROVIDER_KINDS.pull_request ? "https://api.github.com/rate_limit" : null;
      if (!url) return { ok: false, error: { operation: "probe_provider", entity_id: kind, detail: "unknown provider kind" } };
      try {
        const response = await http(url, { signal: AbortSignal.timeout(10_000),
          ...(kind === PROVIDER_KINDS.pull_request ? { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "oakridge" } } : {}) });
        return response.ok ? { ok: true, value: true }
          : { ok: false, error: { operation: "probe_provider", entity_id: kind, detail: `probe returned ${response.status}` } };
      } catch (cause) { return { ok: false, error: { operation: "probe_provider", entity_id: kind, detail: String(cause) } }; }
    },
    async check_github(input) {
    if (!token) return { ok: false, error: { operation: "check_github", entity_id: "github", detail: "token is absent" } };
    const targets = forgeRepositories(input);
    // A reachable `/user` says nothing about pull-request access, so an input naming no repository fails closed.
    if (targets.length === 0) return { ok: false, error: { operation: "check_github", entity_id: "github", detail: "run input names no GitHub repository to check" } };
    const urls = targets.map((target) => `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.name)}/pulls?per_page=1`);
    for (const url of urls) {
      try {
        const response = await http(url, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "oakridge" }, signal: AbortSignal.timeout(10_000) });
        if (!response.ok) return { ok: false, error: { operation: "check_github", entity_id: url, detail: `repository pull-request read denied (${response.status})` } };
      } catch (cause) { return { ok: false, error: { operation: "check_github", entity_id: url, detail: String(cause) } }; }
    }
    return { ok: true, value: true };
    },
  };
}

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
    args: ["--max-list-items", "10000", "--max-depth", String(CORE_MAX_DEPTH), "--evaluation-budget", "1000000"], deadlineMs: 10_000 });
  if (!started.ok) throw new Error(`workflow-cli could not start: ${started.error.detail.detail}`);
  const core = started.value;
  let db: PgPostgresExecutor;
  try { db = PgPostgresExecutor.connect(options.database_url); }
  catch (cause) { core.close(); throw cause; }
  let launch_attempted = false;
  try {
  await verifyEffectEncryption(db);
  const provider_capabilities = options.provider_capabilities ?? githubProviderCapabilities(process.env.OAKRIDGE_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN ?? "", fetch,
    options.kbbl_base_url ?? process.env.KBBL_BASE_URL ?? "http://127.0.0.1:8788");
  const mutations = createMutationService(db, core, provider_capabilities);
  const repositories = authorityRepositories(db);
  const provider = options.effect_provider ?? createEffectProvider({ db, core, kbbl_base_url: options.kbbl_base_url ?? process.env.KBBL_BASE_URL ?? "http://127.0.0.1:8788", pull_requests: options.pull_requests });
  const application_version = options.application_version ?? selectApplicationVersion();
  registerWorkflowServices({ db, core, mutations, provider, timing: { ...DEFAULT_WORKFLOW_TIMING, ...options.timing } });
  DBOS.setConfig({ name: "oakridge", systemDatabaseUrl: options.database_url, applicationVersion: application_version });
  launch_attempted = true;
  await DBOS.launch();
  await resumeActiveRuns(db);
  const wake = (run_id: RunId): Promise<void> => wakeRun(run_id);
  const app = new Hono();
  app.use("*", httpBodyLimit());
  app.use("*", redactingReadResponses());
  const write_policy = configuredBrowserWritePolicy();
  app.use("*", browserWriteMiddleware(write_policy));
  if (access.kind === "token_required") app.use("*", controlTokenMiddleware(access.token, write_policy));
  installDefinitionApi(app, { db, core, mutations, wake });
  app.get("/health", (context) => context.json({ status: "ok", application_version, core: core.health }));
  app.post("/runs", async (context) => {
    let body: unknown;
    try { body = await context.req.json(); } catch { return context.json({ error: "invalid JSON" }, 400); }
    if (body && typeof body === "object" && "digest" in body) {
      if (typeof body.digest !== "string" || !("input" in body)) return context.json({ error: "digest and input are required" }, 400);
      if (!("request_id" in body) || typeof body.request_id !== "string" || body.request_id.length < 1 || body.request_id.length > 200)
        return context.json({ error: "request_id must contain 1 to 200 characters" }, 400);
      const result = await mutations.startRunByDigest({ digest: body.digest, input: body.input, request_id: body.request_id });
      if (!result.ok) {
        const status = result.error.operation === "launch_conflict" ? 409 : result.error.operation === "launch_gone" ? 410
          : result.error.operation === "start_run_storage" ? 500 : 422;
        return context.json({ error: status === 500 ? "launch storage failed; retry with the same request_id" : result.error }, status);
      }
      await ensureRunWorkflow(result.value.run_id);
      return context.json(result.value, 201);
    }
    if (!body || typeof body !== "object" || !("bundle" in body) || !isBundle(body.bundle) || !("input" in body)) return context.json({ error: "invalid run request" }, 400);
    const result = await mutations.startRun({ bundle: body.bundle, input: body.input });
    if (!result.ok) return context.json({ error: result.error }, result.error.operation === "start_run_storage" ? 500 : 422);
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
  if (activeRoutes(process.env.OAKRIDGE_ENABLE_RAW_INGRESS === "1").some((route) => route.raw_ingress)) app.post("/runs/:run_id/scopes/:scope_id/decide", async (context) => {
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
  return { app, application_version, provider_capabilities, async close() {
    try { await parkRunningWorkflows(); }
    finally { try { await DBOS.shutdown(); } finally { core.close(); await db.close(); } }
  } };
  } catch (cause) {
    try { if (launch_attempted) await DBOS.shutdown(); }
    finally { core.close(); await db.close(); }
    throw cause;
  }
}
