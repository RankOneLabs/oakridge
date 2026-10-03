import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { ArtifactRef, AcceptedBuild, BuildResponse, ImplementationCohortDefinition, ImplementationCohortInputs,
  OperatorRequest } from "../../src/domain/dev-flow-v15";
import type { CohortId, ExecutionId, StageInstanceId, WorkflowRunId } from "../../src/domain/primitives";
import { createDevFlowAdapterRegistry } from "../../src/adapters/dev-flow";
import { KbblExecutorAdapter } from "../../src/adapters/kbbl";
import { createWorkOrderArtifactCallbackApp } from "../../src/http/work-order-artifact-callback";
import { createImplementationWorkerSessionIO } from "../../src/runtime/implementation-worker-session";
import { createImplementationPublicationEnricher } from "../../src/runtime/implementation-publication";
import { GithubPullRequestReader } from "../../src/runtime/github-pull-requests";
import { verifyCohortPullRequest } from "../../src/runtime/cohort-pull-request";
import { dispatchCohortExecution } from "../../src/runtime/run-launch-dispatch";
import { BunGitCommandRunner } from "../../src/runtime/git-command-runner";
import { seedBuiltins } from "../../src/seed/seed-builtins";
import { PostgresWorkflowDefinitionRepository } from "../../src/storage/postgres-workflow-definitions";
import { PostgresForgeRepositoryRepository } from "../../src/storage/postgres-domain";
import { PostgresDevFlowPullRequestRepository } from "../../src/storage/postgres-dev-flow";
import { PostgresRunRecordRepository } from "../../src/storage/postgres-run-record-repository";
import { PostgresRunRecordWriter } from "../../src/storage/postgres-run-record";
import { StageEventApplier } from "../../src/storage/apply-stage-event";
import { applyMigrations } from "../../src/storage/migrate";
import { PgPostgresExecutor } from "../../src/storage/sql-executor";
import { createScratchDatabase } from "./durable-database";
import type { ImplementationAgentPlan, ImplementationAgentLaunch, ImplementationAgentDelivery } from "./implementation-agent";

export const waitFor = async <Value>(label: string, read: () => Promise<Value | null>): Promise<Value> => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
};

export interface ForgeFixture {
  state: "open" | "closed";
  merged_at: string | null;
  head_sha: string | null;
  head_branch: string;
  base_branch: string;
  number: number;
}

/** Seeds only a prepared B3 cohort. Full-run stage materialization belongs to B4. */
export const createImplementationCohortHarness = async () => {
  const scratch = await createScratchDatabase(`oakridge_b3_${randomUUID().replaceAll("-", "")}`);
  if (!scratch.ok) throw new Error(scratch.error.detail);
  const sql = PgPostgresExecutor.connect(scratch.value.url);
  const root = await mkdtemp(join(tmpdir(), "oakridge-b3-"));
  const repo = join(root, "repo");
  const origin = join(root, "origin.git");
  const git = new BunGitCommandRunner();
  const runGit = async (directory: string, args: readonly string[]): Promise<string> => {
    const result = await git.run(directory, args);
    if (result.exit_code !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  const launches: ImplementationAgentLaunch[] = [];
  const deliveries: ImplementationAgentDelivery[] = [];
  const plans = new Map<string, ImplementationAgentPlan>();
  const forge: ForgeFixture = { state: "open", merged_at: null, head_sha: null,
    head_branch: "cohort/core", base_branch: "epic/schema", number: 1 };
  const now = () => new Date().toISOString();
  const control = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/launch") { launches.push(await request.json() as ImplementationAgentLaunch); return Response.json({}); }
    if (path === "/delivery") { deliveries.push(await request.json() as ImplementationAgentDelivery); return Response.json({}); }
    if (path.startsWith("/plan/")) return Response.json(plans.get(path.slice(6)) ?? null);
    return new Response(null, { status: 404 });
  } });
  const forgeServer = Bun.serve({ port: 0, async fetch(request) {
    const match = new URL(request.url).pathname.match(/^\/repos\/example\/oakridge\/pulls\/(\d+)$/);
    if (!match) return new Response(null, { status: 404 });
    const head = forge.head_sha ?? (await runGit(repo, ["ls-remote", "origin", "refs/heads/cohort/core"])).split(/\s+/)[0];
    return Response.json({ number: forge.number, html_url: `https://github.com/example/oakridge/pull/${match[1]}`,
      state: forge.state, merged: forge.merged_at !== null, merged_at: forge.merged_at,
      head: { ref: forge.head_branch, sha: head }, base: { ref: forge.base_branch } });
  } });
  let kbbl: ReturnType<typeof Bun.spawn> | null = null;
  let server: ReturnType<typeof Bun.serve> | null = null;
  const close = async () => {
    if (kbbl) { kbbl.kill(); await kbbl.exited; }
    server?.stop(true); control.stop(true); forgeServer.stop(true);
    await sql.close(); await scratch.value.drop(); await rm(root, { recursive: true, force: true });
  };
  try {
    await runGit(root, ["init", "-b", "cohort/core", repo]);
    await runGit(repo, ["-c", "user.name=B3", "-c", "user.email=b3@example.invalid", "-c", "commit.gpgsign=false",
      "commit", "--allow-empty", "-m", "base"]);
    const base = await runGit(repo, ["rev-parse", "HEAD"]);
    await runGit(repo, ["branch", "epic/schema", base]);
    await runGit(root, ["clone", "--bare", "--shared", repo, origin]);
    await runGit(repo, ["remote", "add", "origin", origin]);
    await applyMigrations(sql);
    const definitions = new PostgresWorkflowDefinitionRepository(sql, createDevFlowAdapterRegistry());
    await seedBuiltins(definitions);
    const definition = (await Bun.file(resolve(import.meta.dir, "../../../workflow-config/definitions/dev_flow_v15.json")).json())
      .stages.implementation.cohort as ImplementationCohortDefinition;
    const definitionId = (await sql.query<{ readonly id: string }>("SELECT id::text FROM oakridge.workflow_definition", []))[0]!.id;
    const bundle = (await definitions.find_bound_prompt_bundle(definitionId as never))!;
    const run_id = randomUUID() as WorkflowRunId;
    const stage_id = randomUUID() as StageInstanceId;
    const cohort_id = randomUUID() as CohortId;
    const brief: ArtifactRef = { id: randomUUID() as never, version: 1 };
    const inputs: ImplementationCohortInputs = { brief, repository: {
      refs: { repository_key: "oakridge" as never, repository_path: repo, integration_branch: "epic/schema",
        base_branch: "epic/schema", base_head_sha: base as never }, worktree_path: repo, worktree_base_sha: base as never,
      canonical_branch: "cohort/core", expected_pr_base: "epic/schema" } };
    const context = { builder: { runtime: "claude-code", model: null, effort: null },
      planner: { runtime: "claude-code", model: null, effort: null }, oakridge_url: "",
      repositories: [{ key: "oakridge", path: repo, integration_branch: "epic/schema", forge_repository: { provider: "github", owner: "example", name: "oakridge" } }] };
    await sql.query(`INSERT INTO oakridge.workflow_run (id,workflow_definition_id,context,bundle_pin,status)
      VALUES ($1,$2,$3::jsonb,$4::jsonb,'active')`, [run_id, definitionId, JSON.stringify(context),
      JSON.stringify({ definition_version: 1, prompt_bundle_hash: bundle.hash, adapter_version: "test", artifact_schema_version: "v1" })]);
    await sql.query(`INSERT INTO oakridge.stage_instance (id,run_id,stage_key,stage_type,stage_contract,status)
      VALUES ($1,$2,'implementation','delegated_session',$3::jsonb,'active')`, [stage_id, run_id, JSON.stringify({ cohort: definition })]);
    await sql.query(`INSERT INTO oakridge.cohort (id,run_id,stage_instance_id,cohort_key,state,status,frozen_inputs)
      VALUES ($1,$2,$3,'core','pending','pending',$4::jsonb)`, [cohort_id, run_id, stage_id, JSON.stringify(inputs)]);
    for (const worker of ["build", "assessment"]) await sql.query("INSERT INTO oakridge.cohort_worker (cohort_id,worker) VALUES ($1,$2)", [cohort_id, worker]);
    await sql.query("INSERT INTO oakridge.artifact (id,chain_id,revision,artifact_type,body) VALUES ($1,$1,1,'dev.build_brief',$2::jsonb)",
      [brief.id, JSON.stringify({ title: "Boundary proof", acceptance_criteria: ["check both outputs"] })]);
    await sql.query("INSERT INTO oakridge.artifact_owner (artifact_id,run_id) VALUES ($1,$2)", [brief.id, run_id]);
    const pullRequests = new PostgresDevFlowPullRequestRepository(sql);
    const prepared = await pullRequests.create_cohort({ cohort_id, stage_instance_id: stage_id, cohort_key: "core", repository_key: "oakridge",
      repository_path: repo, canonical_ref: "cohort/core", expected_pr_base: "epic/schema", recorded_head_sha: base,
      current_verified_pull_request_id: null, created_at: now(), updated_at: now() });
    if (!prepared.ok) throw new Error(prepared.error.detail);
    const portProbe = Bun.serve({ port: 0, fetch: () => new Response() });
    const port = portProbe.port!; portProbe.stop(true);
    const config = join(root, "config.json");
    const profile = { command: process.execPath, args: [resolve(import.meta.dir, "implementation-agent.ts"), "--b3-agent"],
      require_load_session: true, env_policy: { inherit: true, set: {
        OAKRIDGE_B3_AGENT_CONTROL_URL: `http://127.0.0.1:${control.port}`, OAKRIDGE_B3_ORIGIN_PATH: origin } } };
    await Bun.write(config, JSON.stringify({ acp: { default_agent: "claude-code", agents: { "claude-code": profile, codex: profile } } }));
    kbbl = Bun.spawn([process.execPath, "run", resolve(import.meta.dir, "../../../kbbl/core/server.ts"), `--port=${port}`,
      "--host=127.0.0.1", `--dataDir=${join(root, "kbbl")}`, `--config=${config}`, `--workdir=${repo}`],
      { cwd: resolve(import.meta.dir, "../../.."), stdout: "ignore", stderr: "pipe" });
    await waitFor("kbbl", async () => {
      if (kbbl?.exitCode !== null) throw new Error(`kbbl exited: ${await new Response(kbbl!.stderr as ReadableStream<Uint8Array>).text()}`);
      return (await fetch(`http://127.0.0.1:${port}/config`).catch(() => null))?.ok ? true : null;
    });
    const adapter = new KbblExecutorAdapter({ base_url: `http://127.0.0.1:${port}`, executor_function_identity: run_id, observe_wait_ms: 100 });
    const reader = new GithubPullRequestReader({ token: "fixture", api_base_url: `http://127.0.0.1:${forgeServer.port}` });
    const writer = new PostgresRunRecordWriter(sql, createDevFlowAdapterRegistry());
    const ingress = new StageEventApplier({ sql, writer, now,
      observe_pr: async () => {
        const current = await pullRequests.find_current_for_unit(stage_id, "core" as never);
        if (!current) return null;
        const observation = await verifyCohortPullRequest({ reader, git }, { cohort: current.cohort,
          forge_repository: { owner: "example", name: "oakridge" }, candidate_url: current.pull_request.url });
        return observation.ok ? { pr_url: observation.value.observation.url, repository_key: "oakridge" as never,
          head_branch: observation.value.observation.head_branch, base_branch: observation.value.observation.base_branch,
          head_sha: observation.value.pushed_head_sha as never,
          state: observation.value.observation.state === "closed_unmerged" ? "closed" : observation.value.observation.state } : null;
      },
      dispatch_executions: async (ids) => { for (const id of ids) {
        const result = await dispatchCohortExecution(sql, id, io);
        if (!result.ok) throw new Error(result.error.detail);
      } } });
    const records = new PostgresRunRecordRepository(sql, writer, ingress);
    const io = createImplementationWorkerSessionIO({ sql, records, now, find_executor: () => adapter,
      prompt_bundle: async () => bundle.matrix, run_context: async () => context });
    const enrich = createImplementationPublicationEnricher({ sql, git, pull_requests: pullRequests,
      forge_repositories: new PostgresForgeRepositoryRepository(sql), reader });
    const app = createWorkOrderArtifactCallbackApp({ records, now, enrich });
    server = Bun.serve({ port: 0, fetch: app.fetch });
    context.oakridge_url = `http://127.0.0.1:${server.port}`;
    await sql.query("UPDATE oakridge.workflow_run SET context=$2::jsonb WHERE id=$1", [run_id, JSON.stringify(context)]);
    const advance = async (request: OperatorRequest | null = null) => {
      const version = Number((await sql.query<{ readonly durable_version: string }>(
        "SELECT durable_version::text FROM oakridge.cohort WHERE id=$1", [cohort_id]))[0]!.durable_version);
      const result = await ingress.advance(cohort_id, request ? { id: randomUUID() as never, cohort_id, expected_version: version, request } : null);
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      return result.value;
    };
    const launch = async (index: number) => waitFor(`launch ${index}`, async () => launches[index] ?? null);
    const execute = async (index: number, plan: ImplementationAgentPlan) => {
      const selected = await launch(index); plans.set(selected.attempt_id, plan);
      if (plan.kind === "exit_without_publication") return [];
      return waitFor(`publications from ${selected.attempt_id}`, async () => {
        const answers = deliveries.filter((delivery) => delivery.attempt_id === selected.attempt_id);
        return answers.length === plan.publications.length ? answers : null;
      });
    };
    const build = async (): Promise<BuildResponse> => (await sql.query<{ readonly response: BuildResponse }>(
      "SELECT response FROM oakridge.cohort_worker WHERE cohort_id=$1 AND worker='build'", [cohort_id]))[0]!.response;
    const accepted = async (): Promise<AcceptedBuild> => (await sql.query<{ readonly accepted_build: AcceptedBuild }>(
      "SELECT accepted_build FROM oakridge.cohort WHERE id=$1", [cohort_id]))[0]!.accepted_build;
    const assessment = async (): Promise<ArtifactRef> => {
      const row = (await sql.query<{ readonly chain_id: string; readonly revision: number }>(
        `SELECT artifact.chain_id::text,artifact.revision FROM oakridge.worker_output output
         JOIN oakridge.artifact artifact ON artifact.id=output.artifact_id WHERE output.cohort_id=$1 AND output.worker='assessment'`, [cohort_id]))[0]!;
      return { id: row.chain_id as never, version: row.revision };
    };
    return { sql, database_url: scratch.value.url, ingress, io, enrich, records, adapter, cohort_id, run_id, stage_id, launches, deliveries, forge, advance, launch, execute,
      build, accepted, assessment, close, app, now,
      execution: async (index: number): Promise<ExecutionId> => {
        const selected = await launch(index);
        return (await sql.query<{ readonly id: ExecutionId }>("SELECT id::text FROM oakridge.execution_intent WHERE attempt_id=$1", [selected.attempt_id]))[0]!.id;
      } };
  } catch (cause) { await close(); throw cause; }
};
