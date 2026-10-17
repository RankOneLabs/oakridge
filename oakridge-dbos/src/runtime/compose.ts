import { DBOS } from "@dbos-inc/dbos-sdk";
import type { Hono } from "hono";
import { CoreClient } from "../core-client/client";
import type { RunId } from "../domain/primitives";
import { selectControlPlaneAccess } from "../http/control-auth";
import { configuredBrowserWritePolicy } from "../http/browser-write-policy";
import { createHttpApp } from "../http/app";
import { openDatabase, type Database } from "../storage/database";
import { KbblClient } from "../adapters/kbbl";
import { createAgentProvider } from "../effects/agent-provider";
import type { EffectProvider } from "../effects/provider";
import { createOperationRunner, type OperationRunner } from "../operations/runner";
import { BunGitCommandRunner } from "./git-command-runner";
import { GithubPullRequestReader } from "./github-pull-requests";
import { selectApplicationVersion } from "../workflows/engine-version";
import { DEFAULT_WORKFLOW_TIMING, parkRunningWorkflows, registerWorkflowServices, resumeActiveRuns, sweepRunsNeedingWork, wakeRun, type WorkflowTiming } from "../workflows/topology";

/** Where the executor carries attempts: agents to kbbl, code workers to the registered operations. */
export interface ExecutorOptions {
  /** Null runs no agent: each agent attempt fails with `kbbl_unconfigured`. */
  readonly kbbl_base_url: string | null;
  /** kbbl's control token, presented on every executor call to kbbl; null when kbbl runs without one. */
  readonly kbbl_control_token?: string | null;
  /** Derives each session's publication secret; required with kbbl. */
  readonly publication_key: string | null;
  /** This backend as agents reach it, for the publish endpoint in their preamble. */
  readonly publish_base_url: string;
  /** Where a `workspace: none` session runs. */
  readonly agent_workdir: string;
  /** Null leaves `pull_request.observe` without a reader: it fails with `discovery_unsupported`. */
  readonly github_token: string | null;
}
export interface ProductionOptions {
  readonly database_url: string; readonly host: string; readonly control_token?: string;
  readonly executor?: ExecutorOptions;
  /** Overrides for tests; production builds them from `executor`. */
  readonly effect_provider?: EffectProvider;
  readonly operation_runner?: OperationRunner;
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
const RUN_SWEEP_INTERVAL_MS = 60_000;
/** Recover runs a lost wake left without a workflow; a sweep still in flight skips the next tick. */
function startRunSweep(db: Database): ReturnType<typeof setInterval> {
  let is_sweeping = false;
  return setInterval(() => {
    if (is_sweeping) return;
    is_sweeping = true;
    sweepRunsNeedingWork(db)
      .catch((error: unknown) => DBOS.logger.warn(`run sweep failed: ${String(error)}`))
      .finally(() => { is_sweeping = false; });
  }, RUN_SWEEP_INTERVAL_MS);
}

export async function createProductionComposition(options: ProductionOptions): Promise<ProductionComposition> {
  const access = selectControlPlaneAccess({ host: options.host, token: options.control_token, allow_insecure_non_loopback: process.env.ALLOW_INSECURE_NON_LOOPBACK_CONTROL === "1" });
  if (access.kind === "refused") throw new Error(access.detail);
  const executor = options.executor;
  if (executor?.kbbl_base_url && !executor.publication_key) throw new Error("OAKRIDGE_PUBLICATION_KEY is required when KBBL_BASE_URL is set");
  const provider = options.effect_provider ?? createAgentProvider({ kbbl: executor?.kbbl_base_url ? new KbblClient({ base_url: executor.kbbl_base_url, control_token: executor.kbbl_control_token ?? null }) : null,
    publication_key: executor?.publication_key ?? null, publish_base_url: executor?.publish_base_url ?? "", default_workdir: executor?.agent_workdir ?? "" });
  const operations = options.operation_runner ?? createOperationRunner({ git: new BunGitCommandRunner(),
    pull_requests: executor?.github_token ? new GithubPullRequestReader({ token: executor.github_token }) : null });
  const started = CoreClient.start();
  if (!started.ok) throw new Error(`workflow WASM could not load: ${started.error.detail.detail}`);
  const core = started.value;
  const db = openDatabase(options.database_url);
  let launch_attempted = false;
  try {
    const application_version = options.application_version ?? selectApplicationVersion();
    registerWorkflowServices({ db, core, provider, operations,
      timing: { ...DEFAULT_WORKFLOW_TIMING, ...options.timing } });
    DBOS.setConfig({ name: "oakridge", systemDatabaseUrl: options.database_url, applicationVersion: application_version });
    launch_attempted = true;
    await DBOS.launch();
    await resumeActiveRuns(db);
    const sweep = startRunSweep(db);
    const wake = (run_id: RunId): void => { void wakeRun(run_id); };
    const app = createHttpApp({ db, core, wake, application_version, write_policy: configuredBrowserWritePolicy(), access });
    return { app, application_version, async close() {
      clearInterval(sweep);
      try { await parkRunningWorkflows(); }
      finally { try { await DBOS.shutdown(); } finally { core.close(); await db.destroy(); } }
    } };
  } catch (cause) {
    try { if (launch_attempted) await DBOS.shutdown(); }
    finally { core.close(); await db.destroy(); }
    throw cause;
  }
}
