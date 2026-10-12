import { DBOS } from "@dbos-inc/dbos-sdk";
import { Hono } from "hono";
import { CoreClient } from "../core-client/client";
import type { RunId } from "../domain/primitives";
import { controlTokenMiddleware, selectControlPlaneAccess } from "../http/control-auth";
import { browserWriteMiddleware, configuredBrowserWritePolicy } from "../http/browser-write-policy";
import { httpBodyLimit, installDefinitionApi } from "../http/app";
import { errorResponse, fault, MissingEntityError } from "../http/errors";
import { installEventStream } from "../http/events";
import { redactingReadResponses } from "../projections/serialization-view";
import { openDatabase } from "../storage/database";
import { deleteRun } from "../storage/run-deletion";
import type { EffectProvider } from "../effects/provider";
import { createEffectProvider } from "../effects/operations/production-provider";
import { selectApplicationVersion } from "../workflows/engine-version";
import { DEFAULT_WORKFLOW_TIMING, parkRunningWorkflows, registerWorkflowServices, resumeActiveRuns, wakeRun, type WorkflowTiming } from "../workflows/topology";

export interface ProductionOptions {
  readonly database_url: string; readonly host: string; readonly control_token?: string;
  readonly effect_provider?: EffectProvider;
  /** Overrides for tests; production uses the defaults. */
  readonly timing?: Partial<WorkflowTiming>;
  /** Defaults to the engine digest, or `DBOS_APPLICATION_VERSION` when set. */
  readonly application_version?: string;
}
export interface ProductionComposition { readonly app: Hono; readonly application_version: string; close(): Promise<void> }

/**
 * The production composition. DBOS is the runtime: it is configured and
 * launched here, every run gets a durable workflow, and effect intents are
 * carried by workflows that resume after a crash. Nothing here polls.
 */
export async function createProductionComposition(options: ProductionOptions): Promise<ProductionComposition> {
  const access = selectControlPlaneAccess({ host: options.host, token: options.control_token, allow_insecure_non_loopback: process.env.ALLOW_INSECURE_NON_LOOPBACK_CONTROL === "1" });
  if (access.kind === "refused") throw new Error(access.detail);
  const started = CoreClient.start();
  if (!started.ok) throw new Error(`workflow WASM could not load: ${started.error.detail.detail}`);
  const core = started.value;
  const db = openDatabase(options.database_url);
  let launch_attempted = false;
  try {
    const application_version = options.application_version ?? selectApplicationVersion();
    registerWorkflowServices({ db, core, provider: options.effect_provider ?? createEffectProvider(),
      timing: { ...DEFAULT_WORKFLOW_TIMING, ...options.timing } });
    DBOS.setConfig({ name: "oakridge", systemDatabaseUrl: options.database_url, applicationVersion: application_version });
    launch_attempted = true;
    await DBOS.launch();
    await resumeActiveRuns(db);
    const wake = (run_id: RunId): void => { void wakeRun(run_id); };
    const app = new Hono();
    app.use("*", httpBodyLimit());
    app.use("*", redactingReadResponses());
    const write_policy = configuredBrowserWritePolicy();
    app.use("*", browserWriteMiddleware(write_policy));
    if (access.kind === "token_required") app.use("*", controlTokenMiddleware(access.token, write_policy));
    installDefinitionApi(app, { db, core, wake });
    installEventStream(app, { db });
    app.get("/health", (context) => context.json({ status: "ok", application_version, core: core.health }));
    app.delete("/runs/:run_id", async (context) => {
      try {
        const result = await deleteRun(db, context.req.param("run_id") as RunId);
        if (result.kind === "missing") return errorResponse(new MissingEntityError("run not found"));
        return context.json(result, result.kind === "refused" ? 409 : 200);
      } catch (cause) { return fault(cause); }
    });
    return { app, application_version, async close() {
      try { await parkRunningWorkflows(); }
      finally { try { await DBOS.shutdown(); } finally { core.close(); await db.destroy(); } }
    } };
  } catch (cause) {
    try { if (launch_attempted) await DBOS.shutdown(); }
    finally { core.close(); await db.destroy(); }
    throw cause;
  }
}
