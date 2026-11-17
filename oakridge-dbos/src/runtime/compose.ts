import { readInstallStatus } from "../http/install-status";
import { selectAccessMode, type AccessModeInput } from "../projections/install-status-view";
import { readCommittedRunConfig, selectCommittedPrIntegration } from "../storage/read-store";
import type { PrIntegration } from "../domain/pr-integration";
import type { PrIntegrationHealth } from "./pr-launch-preflight";
import { DBOS } from "@dbos-inc/dbos-sdk";
import type { Hono } from "hono";
import { CoreClient } from "../core-client/client";
import type { RunId } from "../domain/primitives";
import { selectControlPlaneAccess } from "../http/control-auth";
import { configuredBrowserWritePolicy } from "../http/browser-write-policy";
import type { PrLaunchDependencies } from "../http/ingress";
import { createHttpApp } from "../http/app";
import { openDatabase } from "../storage/database";
import { KbblClient } from "../adapters/kbbl";
import { startObservationPublisher, type ObservationOptions } from "../adapters/observation";
import { createAgentProvider } from "../effects/agent-provider";
import type { EffectProvider } from "../effects/provider";
import { createOperationRunner, type OperationRunner } from "../operations/runner";
import { BunGitCommandRunner } from "./git-command-runner";
import { GatedReviewPullRequestReader } from "./gated-review-pull-requests";
import { startRunSweep } from "./run-sweep";
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
  readonly gated_review_url: string | null;
}
export interface ProductionOptions {
  readonly operator_access?: AccessModeInput;
  readonly pr_integration_default?: PrIntegration;
  readonly database_url: string; readonly host: string; readonly control_token?: string;
  readonly executor?: ExecutorOptions;
  /** Overrides for tests; production builds them from `executor`. */
  readonly effect_provider?: EffectProvider;
  readonly operation_runner?: OperationRunner;
  /** Overrides for tests; production uses the defaults. */
  readonly timing?: Partial<WorkflowTiming>;
  /** Defaults to the engine digest, or `DBOS_APPLICATION_VERSION` when set. */
  readonly application_version?: string;
  readonly observation?: ObservationOptions | null;
}
export interface ProductionComposition { readonly app: Hono; readonly application_version: string; close(): Promise<void> }

/**
 * The production composition. DBOS is the runtime: it is configured and
 * launched here, every run gets a durable workflow, and effect intents are
 * carried by workflows that resume after a crash.
 */
export async function createProductionComposition(options: ProductionOptions): Promise<ProductionComposition> {
  const access = selectControlPlaneAccess({ host: options.host, token: options.control_token, allow_insecure_non_loopback: process.env.ALLOW_INSECURE_NON_LOOPBACK_CONTROL === "1" });
  if (access.kind === "refused") throw new Error(access.detail);
  if (options.operator_access) {
    const operator_access = selectAccessMode(options.operator_access);
    if (operator_access.kind === "failed") throw new Error(operator_access.detail);
  }
  const executor = options.executor;
  if (executor?.kbbl_base_url && !executor.publication_key) throw new Error("OAKRIDGE_PUBLICATION_KEY is required when KBBL_BASE_URL is set");
  const db = openDatabase(options.database_url);
  const provider = options.effect_provider ?? createAgentProvider({
    read_pr_integration: async (run_id) => {
      const recorded = await readCommittedRunConfig(db, run_id);
      const integration = selectCommittedPrIntegration(recorded);
      return integration === null ? null : { pr_integration: integration,
        pr_skill_digest: recorded.state === "committed" ? recorded.config.pr_skill_digest : null };
    }, kbbl: executor?.kbbl_base_url ? new KbblClient({ base_url: executor.kbbl_base_url, control_token: executor.kbbl_control_token ?? null }) : null,
    publication_key: executor?.publication_key ?? null, publish_base_url: executor?.publish_base_url ?? "", default_workdir: executor?.agent_workdir ?? "" });
  const operations = options.operation_runner ?? createOperationRunner({ git: new BunGitCommandRunner(),
    pull_requests: executor?.gated_review_url ? new GatedReviewPullRequestReader(executor.gated_review_url) : null });
  const started = CoreClient.start();
  if (!started.ok) throw new Error(`workflow WASM could not load: ${started.error.detail.detail}`);
  const core = started.value;
  let launch_attempted = false;
  try {
    const application_version = options.application_version ?? selectApplicationVersion();
    registerWorkflowServices({ db, core, provider, operations,
      timing: { ...DEFAULT_WORKFLOW_TIMING, ...options.timing } });
    DBOS.setConfig({ name: "oakridge", systemDatabaseUrl: options.database_url, applicationVersion: application_version });
    launch_attempted = true;
    await DBOS.launch();
    await resumeActiveRuns(db);
    const wake = (run_id: RunId): void => { void wakeRun(run_id); };
    const pr_launch: PrLaunchDependencies = { pr_integration_default: options.pr_integration_default ?? "none",
      probe_pr_integration: (integration) => probePrIntegration(integration, executor?.gated_review_url ?? null) };
    const app = createHttpApp({ read_install_status: () => readInstallStatus({
      access: options.operator_access ?? { bind_host: options.host, has_control_token: Boolean(options.control_token?.trim()), allow_insecure_non_loopback: process.env.ALLOW_INSECURE_NON_LOOPBACK_CONTROL === "1" },
      integration: pr_launch.pr_integration_default ?? "none",
      probe_integration: () => probePrIntegration(pr_launch.pr_integration_default ?? "none", executor?.gated_review_url ?? null),
      kbbl: executor?.kbbl_base_url ? new KbblClient({ base_url: executor.kbbl_base_url, control_token: executor.kbbl_control_token ?? null }) : null,
      observation_url: options.observation?.url ?? null, core_ready: true,
    }), observation: options.observation, kbbl: executor?.kbbl_base_url ? new KbblClient({ base_url: executor.kbbl_base_url, control_token: executor.kbbl_control_token ?? null }) : null, ...pr_launch, db, core, wake, application_version, write_policy: configuredBrowserWritePolicy(), access, operations });
    const sweep = startRunSweep(() => sweepRunsNeedingWork(db));
    const observation = options.observation ? startObservationPublisher(db, options.observation) : null;
    return { app, application_version, async close() {
      try { await observation?.stop(); await sweep.stop(); await parkRunningWorkflows(); }
      finally { try { await DBOS.shutdown(); } finally { core.close(); await db.destroy(); } }
    } };
  } catch (cause) {
    try { if (launch_attempted) await DBOS.shutdown(); }
    finally { core.close(); await db.destroy(); }
    throw cause;
  }
}

/** Deadline for each integration health probe (health_probe_semantics); a stalled probe is unhealthy, never awaited forever. */
const PR_PROBE_TIMEOUT_MS = 3000;

/** IO boundary: any HTTP response proves reachability; authentication remains the tool's concern. */
export async function probePrIntegration(integration: PrIntegration, gated_review_url: string | null): Promise<PrIntegrationHealth> {
  if (integration === "none") return { kind: "unconfigured", detail: "selected integration is none" };
  if (integration === "gated-review") {
    if (!gated_review_url) return { kind: "unconfigured", detail: "OAKRIDGE_GATED_REVIEW_URL is unset" };
    try {
      const response = await fetch(gated_review_url, { signal: AbortSignal.timeout(PR_PROBE_TIMEOUT_MS) });
      void response.body?.cancel().catch(() => {});
      return { kind: "healthy" };
    } catch (cause) { return { kind: "unreachable", detail: String(cause) }; }
  }
  const executable = Bun.which("gh", { PATH: process.env.PATH });
  if (!executable) return { kind: "unconfigured", detail: "gh is absent from PATH" };
  try {
    const child = Bun.spawn([executable, "auth", "status"], { stdout: "ignore", stderr: "ignore" });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const timed_out = new Promise<"timed_out">(resolve => { deadline = setTimeout(() => resolve("timed_out"), PR_PROBE_TIMEOUT_MS); });
    const outcome = await Promise.race([child.exited, timed_out]).finally(() => clearTimeout(deadline));
    if (outcome === "timed_out") {
      child.kill("SIGKILL");
      await child.exited;
      return { kind: "unconfigured", detail: `gh auth status did not finish within ${PR_PROBE_TIMEOUT_MS}ms` };
    }
    return outcome === 0 ? { kind: "healthy" } : { kind: "unconfigured", detail: "gh auth status failed" };
  } catch (cause) { return { kind: "unconfigured", detail: String(cause) }; }
}
