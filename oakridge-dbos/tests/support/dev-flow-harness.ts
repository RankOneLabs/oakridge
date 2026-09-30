/**
 * The seeded dev flow, running on the backend the process runs.
 *
 * This harness used to register stub topology services, an in-memory artifact
 * store, and a `send` that posted lifecycle messages straight into a workflow.
 * It called that "faking only the agent". It was not: it also stood in for the
 * artifact emit route, the artifact repository, the notification outbox, the
 * gate resume route and the handoff completion route — which is to say, for
 * every seam where this project's defects actually live. The deadlock that
 * stopped every dev-flow run at its first build unit passed that harness,
 * because the harness supplied by hand the one message production had no way
 * to produce.
 *
 * So it now builds the real thing: `createOakridgeRuntime` against a real
 * PostgreSQL, real repositories, the real HTTP surface listening on a real
 * port. The ACP child is the only fake: it reads the rendered prompt and
 * publishes exactly the outputs and repository refs that prompt authorizes.
 *
 * Bun runs every test file in one process, so one real kbbl and one fake ACP
 * control service are shared while tests swap data with `useScenario`.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { DBOS } from "@dbos-inc/dbos-sdk";

import type { ExecutionRequest } from "../../src/domain/execution";
import type { JsonValue, StageInstanceId, UnitId, WorkflowRunId } from "../../src/domain/primitives";
import type { PromptBundleEntry, StageOperatorRole, WorkflowDefinition } from "../../src/domain/workflow";
import { KbblExecutorAdapter } from "../../src/adapters/kbbl";
import { createOakridgeRuntime, type OakridgeRuntime } from "../../src/runtime/compose";
import { GithubPullRequestReader } from "../../src/runtime/github-pull-requests";
import { applyMigrations } from "../../src/storage/migrate";
import { PgPostgresExecutor } from "../../src/storage/sql-executor";
import type { SqlExecutor } from "../../src/storage/sql-executor";
import { loadDevFlowV15 } from "../../src/seed/dev-flow-v15";

/**
 * How an execution behaves, for the scenario currently running.
 *
 * Exactly one adapter may be registered per process, so scenarios are swapped
 * behind a single adapter rather than registered per test.
 */
let currentScenario: ScriptedAgentScenario | null = null;

/**
 * Which cohorts a run's plan-writer and brief-writer emit, and the
 * `depends_on` each brief carries — a value so scenarios can vary the
 * dependency graph instead of the harness hardcoding one shape.
 */
export interface CohortPlanEntry { readonly id: UnitId; readonly depends_on: readonly UnitId[] }

/** What every test wrote by hand before the plan became a value. */
export const DEFAULT_COHORT_PLAN: readonly CohortPlanEntry[] = [
  { id: "foundation" as UnitId, depends_on: [] },
  { id: "web" as UnitId, depends_on: ["foundation" as UnitId] },
];

/** The seven-brief dependency graph run-16381389 reproduces. */
export const SEVEN_BRIEF_PLAN: readonly CohortPlanEntry[] = [
  { id: "versioning" as UnitId, depends_on: [] },
  { id: "schema" as UnitId, depends_on: [] },
  { id: "docs" as UnitId, depends_on: [] },
  { id: "rollout" as UnitId, depends_on: ["versioning" as UnitId] },
  { id: "api" as UnitId, depends_on: ["schema" as UnitId] },
  { id: "ui" as UnitId, depends_on: ["api" as UnitId, "rollout" as UnitId] },
  { id: "release" as UnitId, depends_on: ["ui" as UnitId, "docs" as UnitId] },
];

/** The plan `artifactBody` mints its cohort/brief bodies from — set by `useScenario`. */
let activeCohortPlan: readonly CohortPlanEntry[] = DEFAULT_COHORT_PLAN;

/** Point the fake ACP process at the scenario for the test about to run. */
export const useScenario = (scenario: ScriptedAgentScenario): void => {
  currentScenario = scenario;
  activeCohortPlan = scenario.cohorts;
};

const requireScenario = (): ScriptedAgentScenario => {
  if (!currentScenario) throw new Error("no execution scenario is active — call useScenario() first");
  return currentScenario;
};

/**
 * What the fake ACP child launched and published after parsing its prompt.
 */
export interface AgentDelivery {
  readonly execution_id: string;
  readonly delivery_key: string;
  readonly prompt: string;
}

export interface FakeAgentLaunch {
  readonly execution_id: string;
  readonly stage_instance_id: StageInstanceId | null;
  readonly expected_artifacts: readonly { readonly unit_id: UnitId; readonly output_name: string; readonly artifact_type: string }[];
  readonly resolved_config: JsonValue;
}

export interface ScriptedAgentScenario {
  /** The cohort plan this scenario's plan-writer and brief-writer emit against. */
  readonly cohorts: readonly CohortPlanEntry[];
  /** Execution workflow id → the request that started it, in launch order. */
  readonly launched: Map<string, FakeAgentLaunch>;
  /** Every follow-up the run has sent an agent — a revision request, say. */
  readonly deliveries: AgentDelivery[];
  readonly forge_overrides: Map<string, { readonly head_branch?: string; readonly head_sha?: string;
    readonly base_branch?: string; readonly merged_at?: string | null }>;
  readonly strip_publication_contract: boolean;
  readonly skip_first_publication_role: StageOperatorRole | null;
  readonly unpublished_work_orders: Set<string>;
  releaseAll(): void;
}

export const scriptedAgentScenario = (options?: {
  readonly cohorts?: readonly CohortPlanEntry[];
  readonly strip_publication_contract?: boolean;
  readonly skip_first_publication_role?: StageOperatorRole;
}): ScriptedAgentScenario => {
  const cohorts = options?.cohorts ?? DEFAULT_COHORT_PLAN;
  const launched = new Map<string, FakeAgentLaunch>();
  const deliveries: AgentDelivery[] = [];
  return {
    cohorts,
    launched,
    deliveries,
    forge_overrides: new Map(),
    strip_publication_contract: options?.strip_publication_contract ?? false,
    skip_first_publication_role: options?.skip_first_publication_role ?? null,
    unpublished_work_orders: new Set(),
    releaseAll() {},
  };
};

export const removePinnedPromptCell = async (
  sql: SqlExecutor, run_id: WorkflowRunId, stage_key: string, role: string, reason: string,
): Promise<() => Promise<void>> => {
  const rows = await sql.query<{ readonly hash: string; readonly matrix: readonly PromptBundleEntry[] }>(
    `SELECT bundle.hash,bundle.matrix FROM oakridge.workflow_run run
     JOIN oakridge.prompt_bundle bundle ON bundle.hash=run.bundle_pin->>'prompt_bundle_hash'
     WHERE run.id=$1`, [run_id]);
  const bundle = rows[0];
  if (!bundle) throw new Error(`run '${run_id}' has no bound prompt bundle`);
  const reduced = bundle.matrix.filter((cell) => !(cell.stage_key === stage_key
    && cell.session_role === role && cell.launch_reason === reason));
  if (reduced.length === bundle.matrix.length) throw new Error(`prompt cell ${stage_key}:${role}:${reason} is missing`);
  await sql.query("UPDATE oakridge.prompt_bundle SET matrix=$2::jsonb WHERE hash=$1",
    [bundle.hash, JSON.stringify(reduced)]);
  return async () => { await sql.query("UPDATE oakridge.prompt_bundle SET matrix=$2::jsonb WHERE hash=$1",
    [bundle.hash, JSON.stringify(bundle.matrix)]); };
};

/** The one branch the harness's runs provision and build on. */
export const HARNESS_BASE_BRANCH = "epic/harness";
/** What the base branch is cut from, and where its work would merge back. */
export const HARNESS_INTEGRATION_BRANCH = "main";

/**
 * A real git repository with a real origin, for the stage that provisions
 * base branches.
 *
 * Faking git here would fake the one thing the provisioning stage is: the
 * sequence of commands that makes a branch exist on a remote. So the fixture is
 * an actual bare repository and an actual working copy pointed at it, and the
 * run pushes to it exactly as it would to GitHub.
 */
export interface GitRepositoryFixture {
  readonly path: string;
  readonly origin_path: string;
  readonly base_branch: string;
  readonly integration_branch: string;
  /** Every ref origin currently holds under `refs/heads/`, read fresh. */
  list_origin_branches(): Promise<readonly string[]>;
  /** What origin says a branch points at, or null when it holds no such branch. */
  origin_branch_sha(branch: string): Promise<string | null>;
  /** Commits onto an existing origin branch, standing in for merged cohort work. Returns the new head. */
  advance_origin_branch(branch: string, message: string): Promise<string>;
  remove(): Promise<void>;
}

/**
 * Fixture git, isolated from whoever is running the suite.
 *
 * The global and system config files are pointed at nothing on purpose. A
 * fixture that inherited them would depend on the developer's identity, aliases
 * and hooks, and on a machine configured to sign commits it cannot even make
 * one — the fixture has no key and no business having one. This is not the
 * signing policy being disabled; it is a throwaway repository having no policy
 * at all. Product code run against the fixture is unaffected: it spawns its own
 * git, with the environment it always has.
 */
const git = async (cwd: string, args: readonly string[]): Promise<string> => {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "oakridge e2e", GIT_AUTHOR_EMAIL: "e2e@oakridge.invalid",
      GIT_COMMITTER_NAME: "oakridge e2e", GIT_COMMITTER_EMAIL: "e2e@oakridge.invalid" } });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} in ${cwd} failed (${exitCode}): ${stderr.trim() || stdout.trim()}`);
  return stdout;
};

/**
 * Setting a fixture up can fail, and the directory exists before it can.
 *
 * Every command below is a subprocess that can refuse — a git too old for
 * `--initial-branch`, a machine whose configuration will not let this identity
 * commit — and the temp directory is already on disk by then. Without this
 * guard a failing setup leaves an `oakridge-e2e-repo-*` behind every time it is
 * run, which is not hypothetical: building this fixture is how the strays that
 * prompted the guard got there.
 */
export const createGitRepositoryFixture = async (): Promise<GitRepositoryFixture> => {
  const root = await mkdtemp(join(tmpdir(), "oakridge-e2e-repo-"));
  const discardRoot = async (): Promise<void> => { await rm(root, { recursive: true, force: true }); };
  const originPath = join(root, "origin.git");
  const workingPath = join(root, "working");
  try {
    await git(root, ["init", "--bare", "--initial-branch", HARNESS_INTEGRATION_BRANCH, originPath]);
    await git(root, ["init", "--initial-branch", HARNESS_INTEGRATION_BRANCH, workingPath]);
    await Bun.write(join(workingPath, "README.md"), "oakridge end-to-end fixture\n");
    await git(workingPath, ["add", "README.md"]);
    await git(workingPath, ["commit", "-m", "fixture base"]);
    await git(workingPath, ["remote", "add", "origin", originPath]);
    await git(workingPath, ["push", "origin", `${HARNESS_INTEGRATION_BRANCH}:refs/heads/${HARNESS_INTEGRATION_BRANCH}`]);
    await git(workingPath, ["fetch", "origin"]);
  } catch (error) {
    await discardRoot();
    throw error;
  }
  return {
    path: workingPath,
    origin_path: originPath,
    base_branch: HARNESS_BASE_BRANCH,
    integration_branch: HARNESS_INTEGRATION_BRANCH,
    async list_origin_branches() {
      const output = await git(workingPath, ["ls-remote", "--heads", "origin"]);
      return output.split("\n").filter(Boolean).map((line) => line.split("refs/heads/")[1] ?? "").filter(Boolean);
    },
    async origin_branch_sha(branch) {
      const output = await git(workingPath, ["ls-remote", "origin", `refs/heads/${branch}`]);
      // `||`, not `??`: `ls-remote` exits 0 with empty output for a branch
      // origin does not have, and splitting an empty string yields `[""]` — so
      // the nullish form returned an empty string where the contract says null.
      return output.trim().split(/\s+/)[0] || null;
    },
    // Committed from a scratch worktree so the fixture's own checkout is never
    // moved off the base branch, which the provisioning commands read.
    async advance_origin_branch(branch, message) {
      const scratch = join(root, `advance-${branch.replaceAll("/", "-")}`);
      await git(workingPath, ["fetch", "origin", branch]);
      await git(workingPath, ["worktree", "add", "--detach", scratch, `origin/${branch}`]);
      try {
        await Bun.write(join(scratch, `${message.replaceAll(/[^a-z]/gi, "-")}.md`), `${message}\n`);
        await git(scratch, ["add", "."]);
        await git(scratch, ["commit", "-m", message]);
        await git(scratch, ["push", "origin", `HEAD:refs/heads/${branch}`]);
        return (await git(scratch, ["rev-parse", "HEAD"])).trim();
      } finally {
        await git(workingPath, ["worktree", "remove", "--force", scratch]);
      }
    },
    remove: discardRoot,
  };
};

export interface IntegrationRuntime {
  readonly runtime: OakridgeRuntime;
  /** Where the real HTTP surface is listening. */
  readonly base_url: string;
  readonly kbbl_url: string;
  readonly forge_override_url: string;
  readonly definition: WorkflowDefinition;
  readonly application_version: string;
  /** The repository the seeded flow's runs provision and build in. */
  readonly repository: GitRepositoryFixture;
  /**
   * Root workflows this file started, cancelled on teardown.
   *
   * A run left mid-flight keeps its executions parked in `recv`, and
   * `DBOS.shutdown()` waits on them — so a test that fails its assertion is
   * followed by a shutdown that times out, and the real failure scrolls away
   * behind a hook error. Cancelling first keeps the first failure the loudest.
   */
  readonly started_runs: string[];
  stop(): Promise<void>;
}

export interface InstallIntegrationRuntimeOptions {
  /**
   * Overrides the prompt-template root the runtime is built with. Scenario 8
   * (spec §5.2) needs a *writable* copy of `workflow-config/prompts` so it can
   * remove and restore one file mid-run; the caller owns making that copy
   * (and cleaning it up) since this harness boots once per file and cannot
   * be re-pointed afterward.
   */
  readonly prompt_template_directory?: string;
}

/**
 * Brings up the backend once for the whole file: schema, DBOS runtime, real
 * repositories, real routes on a real port.
 *
 * `applicationVersion` is unique per launch so a previous run's workflows are
 * never recovered into this one, and concurrent runs on a shared database stay
 * isolated.
 */
export const installIntegrationRuntime = async (databaseUrl: string, options: InstallIntegrationRuntimeOptions = {}): Promise<IntegrationRuntime> => {
  const migrationSql = PgPostgresExecutor.connect(databaseUrl);
  try {
    // Every e2e boot follows the production v15 cutover path after the dump:
    // workers are absent, both application and DBOS state are discarded, and
    // the one baseline reconstructs the application schema from zero.
    const databaseName = new URL(databaseUrl).pathname.replace(/^\//, "");
    const isDedicatedLocalDatabase = databaseName === "oakridge_e2e";
    const isDisposableCiDatabase = process.env.CI === "true" && process.env.OAKRIDGE_TEST_DATABASE_URL === databaseUrl;
    if (!isDedicatedLocalDatabase && !isDisposableCiDatabase && process.env.OAKRIDGE_TEST_ALLOW_SCHEMA_DROP !== "1") {
      throw new Error(`refusing to drop schema 'oakridge' in database '${databaseName}': set OAKRIDGE_TEST_ALLOW_SCHEMA_DROP=1 to confirm it is disposable`);
    }
    await migrationSql.query("DROP SCHEMA IF EXISTS oakridge CASCADE", []);
    await migrationSql.query("DROP SCHEMA IF EXISTS dbos CASCADE", []);
    await migrationSql.query("DROP TABLE IF EXISTS public.oakridge_schema_migration", []);
    await applyMigrations(migrationSql);
  } finally { await migrationSql.close(); }

  const loaded = await loadDevFlowV15();
  if (!loaded.ok) throw new Error(loaded.error.detail);

  const applicationVersion = `e2e-${crypto.randomUUID()}`;
  DBOS.setConfig({ name: "oakridge-dev-flow-e2e", systemDatabaseUrl: databaseUrl, applicationVersion, logLevel: "warn" });

  const repository = await createGitRepositoryFixture();
  const harnessSql = PgPostgresExecutor.connect(databaseUrl);
  const runtimeRoot = await mkdtemp(join(tmpdir(), "oakridge-acceptance-runtime-"));
  const forgeRefs = new Map<string, { readonly head_branch: string; readonly base_branch: string }>();
  let kbblPort = 0;
  let oakridgePort = 0;
  const control = Bun.serve({ port: 0, async fetch(request) {
    const url = new URL(request.url);
    const scenario = requireScenario();
    if (url.pathname === "/scenario") return Response.json({
      cohorts: scenario.cohorts,
      strip_publication_contract: scenario.strip_publication_contract,
    });
    if (url.pathname === "/launch" && request.method === "POST") {
      const launch = await request.json() as { readonly work_order_id: string; readonly unit_id: string; readonly operator_role: StageOperatorRole;
        readonly head_branch: string | null; readonly base_branch: string | null;
        readonly outputs: readonly { readonly output_name: string; readonly unit_id: string }[]; readonly prompt: string };
      const sessions = await fetch(`http://127.0.0.1:${kbblPort}/sessions?include=archived`).then((response) => response.json()) as {
        readonly sessions: readonly { readonly name: string; readonly workflow?: { readonly stageInstanceId?: string } }[];
      };
      const stageInstanceId = sessions.sessions.find((session) => session.name === launch.work_order_id)?.workflow?.stageInstanceId
        ?? launch.prompt.match(/^Stage instance: `([^`]+)`$/m)?.[1];
      scenario.launched.set(launch.work_order_id, {
        execution_id: launch.work_order_id,
        stage_instance_id: stageInstanceId ? stageInstanceId as StageInstanceId : null,
        expected_artifacts: launch.outputs.map((output) => ({ ...output, unit_id: output.unit_id as UnitId, artifact_type: output.output_name })),
        resolved_config: { publication: { work_order_id: launch.work_order_id }, session_name: launch.work_order_id,
          rendered_prompt: launch.prompt, session_identity: { operator_role: launch.operator_role } },
      });
      if (launch.operator_role === "build" && launch.head_branch && launch.base_branch) {
        forgeRefs.set(launch.unit_id, { head_branch: launch.head_branch, base_branch: launch.base_branch });
      }
      const skipPublication = launch.operator_role === scenario.skip_first_publication_role
        && scenario.unpublished_work_orders.size === 0;
      if (skipPublication) scenario.unpublished_work_orders.add(launch.work_order_id);
      return Response.json({ ok: true, stage_instance_id: stageInstanceId ?? null,
        skip_publication: skipPublication });
    }
    if (url.pathname === "/delivery" && request.method === "POST") {
      scenario.deliveries.push(await request.json() as AgentDelivery);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/forge-override" && request.method === "POST") {
      const input = await request.json() as { readonly unit_id: string; readonly head_branch?: string;
        readonly head_sha?: string; readonly base_branch?: string; readonly merged_at?: string | null };
      if (!input.unit_id) return Response.json({ error: "unit_id is required" }, { status: 400 });
      scenario.forge_overrides.set(input.unit_id, input);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/artifact-body" && request.method === "POST") {
      const input = await request.json() as { readonly work_order_id: string; readonly unit_id: string; readonly output_name: string;
        readonly operator_role: StageOperatorRole; readonly revision: number; readonly stage_instance_id: string | null;
        readonly head_branch: string | null; readonly base_branch: string | null };
      if (input.output_name === "pr_summary") {
        const branch = input.head_branch ?? cohortHeadBranch(input.unit_id as UnitId);
        return Response.json({ pr_url: cohortPullRequestUrl(input.unit_id as UnitId), branch,
          base_branch: input.base_branch ?? HARNESS_BASE_BRANCH, repository_key: "oakridge",
          summary: `built ${input.unit_id} v${input.revision}`, review_status: "ready" });
      }
      const synthetic = { execution_id: input.work_order_id, resolved_config: { session_identity: { operator_role: input.operator_role } } } as unknown as ExecutionRequest;
      return Response.json(artifactBody(synthetic, input.unit_id as UnitId, input.output_name, input.revision));
    }
    return new Response("not found", { status: 404 });
  }});
  const forge = Bun.serve({ port: 0, async fetch(request) {
    const match = new URL(request.url).pathname.match(/^\/repos\/RankOneLabs\/oakridge\/pulls\/(\d+)$/);
    if (!match) return new Response("not found", { status: 404 });
    const number = Number(match[1]);
    const unit = activeCohortPlan[number - 1]?.id;
    if (!unit) return new Response("not found", { status: 404 });
    const refs = forgeRefs.get(String(unit));
    if (!refs) return new Response("not found", { status: 404 });
    const override = requireScenario().forge_overrides.get(String(unit));
    const headBranch = override?.head_branch ?? refs.head_branch;
    const head = override?.head_sha ?? await repository.origin_branch_sha(headBranch);
    if (!head) return new Response("not found", { status: 404 });
    const mergedAt = override && "merged_at" in override ? override.merged_at : new Date().toISOString();
    return Response.json({ number, html_url: cohortPullRequestUrl(unit), state: mergedAt ? "closed" : "open",
      merged: mergedAt !== null, merged_at: mergedAt,
      head: { ref: headBranch, sha: head }, base: { ref: override?.base_branch ?? refs.base_branch } });
  }});
  const oakridgePortProbe = Bun.serve({ port: 0, fetch: () => new Response() });
  oakridgePort = oakridgePortProbe.port!;
  oakridgePortProbe.stop(true);
  const kbblPortProbe = Bun.serve({ port: 0, fetch: () => new Response() });
  kbblPort = kbblPortProbe.port!;
  kbblPortProbe.stop(true);
  const configPath = join(runtimeRoot, "kbbl-config.json");
  const driverPath = resolve(import.meta.dir, "dev-flow-driver.ts");
  const fakeAgentProfile = { command: process.execPath, args: [driverPath, "--fake-acp-agent"], require_load_session: true,
    env_policy: { inherit: true, set: { OAKRIDGE_FAKE_AGENT_CONTROL_URL: `http://127.0.0.1:${control.port}` } } };
  await writeFile(configPath, JSON.stringify({ acp: { default_agent: "claude-code", agents: {
    "claude-code": fakeAgentProfile, codex: fakeAgentProfile,
  } } }));
  const kbbl = Bun.spawn([process.execPath, "run", resolve(import.meta.dir, "../../../kbbl/core/server.ts"), `--port=${kbblPort}`,
    `--host=127.0.0.1`, `--dataDir=${join(runtimeRoot, "kbbl-data")}`, `--config=${configPath}`, `--workdir=${repository.path}`], {
    cwd: resolve(import.meta.dir, "../../.."), stdout: "ignore", stderr: "inherit",
    env: { ...process.env, OAKRIDGE_CORE_BASE_URL: `http://127.0.0.1:${oakridgePort}` },
  });
  await awaitCondition("kbbl to start", async () => {
    if (kbbl.exitCode !== null) throw new Error(`kbbl exited before startup with code ${kbbl.exitCode}`);
    return (await fetch(`http://127.0.0.1:${kbblPort}/config`).catch(() => null))?.ok ? true : null;
  }, 20_000);
  const adapter = new KbblExecutorAdapter({ base_url: `http://127.0.0.1:${kbblPort}`, executor_function_identity: applicationVersion, observe_wait_ms: 250 });
  // Only `stop()` removes the fixture, and nothing calls `stop()` on a runtime
  // that never finished being built — so from here to the return, a failure has
  // to take the directory with it. A database that refuses a connection is
  // enough to hit this, and it would leak once per attempt.
  let runtime: OakridgeRuntime;
  let server: ReturnType<typeof Bun.serve>;
  try {
    // No `git_commands` override: the provisioning stage runs real git against
    // the fixture above, because the sequence of commands is the thing under
    // test and a fake runner would agree with whatever it was told.
    runtime = await createOakridgeRuntime({
      database_url: databaseUrl,
      application_version: applicationVersion,
      executor_adapters: [adapter],
      prompt_template_directory: options.prompt_template_directory ?? resolve(import.meta.dir, "../../../workflow-config/prompts"),
      pull_request_reader: new GithubPullRequestReader({ token: "acceptance-token", api_base_url: `http://127.0.0.1:${forge.port}` }),
    });
    await runtime.seed_builtins();
    await DBOS.launch();
    server = Bun.serve({ port: oakridgePort, idleTimeout: 60, fetch: runtime.app.fetch });
  } catch (error) {
    kbbl.kill();
    control.stop(true);
    forge.stop(true);
    await harnessSql.close();
    await rm(runtimeRoot, { recursive: true, force: true });
    await repository.remove();
    throw error;
  }
  const startedRuns: string[] = [];

  return {
    runtime,
    base_url: `http://127.0.0.1:${server.port}`,
    kbbl_url: `http://127.0.0.1:${kbblPort}`,
    forge_override_url: `http://127.0.0.1:${control.port}/forge-override`,
    definition: loaded.value,
    application_version: applicationVersion,
    repository,
    started_runs: startedRuns,
    async stop() {
      for (const rootWorkflowId of startedRuns) {
        await DBOS.cancelWorkflow(rootWorkflowId, { cancelChildren: true }).catch(() => undefined);
      }
      server.stop(true);
      await DBOS.shutdown();
      await runtime.close();
      await harnessSql.close();
      kbbl.kill();
      await kbbl.exited;
      control.stop(true);
      forge.stop(true);
      await rm(runtimeRoot, { recursive: true, force: true });
      await repository.remove();
    },
  };
};

/**
 * A canonical GitHub pull request URL per cohort, so reconciliation has an
 * identity to check. The number is the cohort's position in the active plan
 * (1-based); a cohort id the plan does not name falls back to 1 — the same
 * default the hardcoded version used for every id but "web".
 */
export const cohortPullRequestUrl = (unitId: UnitId): string => {
  const index = activeCohortPlan.findIndex((entry) => entry.id === unitId);
  return `https://github.com/RankOneLabs/oakridge/pull/${index >= 0 ? index + 1 : 1}`;
};
export const cohortHeadBranch = (unitId: UnitId): string => `cohort/${unitId}`;

/** The stage role carried by every delegated request in the seeded v2 flow. */
export const executionOperatorRole = (request: ExecutionRequest): StageOperatorRole => {
  const identity = (request.resolved_config as { readonly session_identity?: { readonly operator_role?: StageOperatorRole | null } }).session_identity;
  if (!identity?.operator_role) throw new Error(`execution '${request.execution_id}' resolved with no operator role`);
  return identity.operator_role;
};

/**
 * The body a faked agent would have produced for a given output.
 *
 * `revision` distinguishes a re-emission from a replay: a revision carries the
 * same identity and different content, which is exactly what the artifact
 * repository keys a new version on.
 */
export const artifactBody = (request: ExecutionRequest, unitId: UnitId, outputName: string, revision = 1): JsonValue => {
  const operatorRole = executionOperatorRole(request);
  if (operatorRole === "spec") return { requirements: [{ id: "R1", description: `harness v${revision}` }] };
  if (operatorRole === "plan") return { cohorts: activeCohortPlan.map(({ id }) => ({ id })) };
  if (operatorRole === "brief") {
    const dependsOn = activeCohortPlan.find((entry) => entry.id === unitId)?.depends_on ?? [];
    return { cohort_id: unitId, repository_key: "oakridge", title: String(unitId), goal: "harness", files_in_scope: [],
      next_action: "build", decisions_made: [], acceptance_criteria: ["passes"], depends_on: dependsOn };
  }
  if (operatorRole === "build") {
    // The two build outputs are genuinely different documents, and the pull
    // request reconciler reads one of them — so the harness has to emit the
    // right shape into the right slot rather than one body into both.
    if (outputName === "pr_summary") {
      return { pr_url: cohortPullRequestUrl(unitId), branch: cohortHeadBranch(unitId), summary: `built ${unitId} v${revision}`, review_status: "ready" };
    }
    return { repository_key: "oakridge", summary: `built ${unitId} v${revision}`, changed_files: [],
      tests: { passed: 1, failed: 0, output: "ok" }, delegated_session_metadata: null, known_issues: [] };
  }
  return { verdict: "pass", findings: [], recommended_next_actions: [], revision };
};

export const runContext = (oakridgeUrl: string, repositoryPath: string) => ({
  brief_notes: "end-to-end harness",
  // One base branch for the run, beside the repositories rather than repeated
  // inside each of them.
  base_branch: HARNESS_BASE_BRANCH,
  repositories: [{ key: "oakridge", path: repositoryPath, integration_branch: HARNESS_INTEGRATION_BRANCH,
    forge_repository: { provider: "github", owner: "RankOneLabs", name: "oakridge" } }],
  oakridge_url: oakridgeUrl,
  planner_runtime: "claude-code" as const, planner_model: null, planner_effort: null,
  worker_runtime: "claude-code" as const, worker_model: null, worker_effort: null,
});

/**
 * Polls a predicate to a deadline.
 *
 * `describe` may be a thunk so a caller can fold in whatever it last saw — a
 * timeout that only says "it did not happen" costs an entire debugging session
 * that the refusal it swallowed would have ended.
 */
export const awaitCondition = async <Value>(
  describe: string | (() => string),
  attempt: () => Promise<Value | null>,
  timeoutMs = 30_000,
): Promise<Value> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await attempt();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`${typeof describe === "function" ? describe() : describe} did not happen within ${timeoutMs}ms`);
    await Bun.sleep(25);
  }
};
