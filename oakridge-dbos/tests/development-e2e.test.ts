import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Workflow } from "../src/core-client/core-types";
import { createOperationRunner } from "../src/operations/runner";
import { GithubPullRequestReader, type PullRequestReader } from "../src/runtime/github-pull-requests";
import { createProductionComposition } from "../src/runtime/compose";
import { BunGitCommandRunner } from "../src/runtime/git-command-runner";
import { launchRunId } from "../src/storage/commit";
import { selectCollectionKey } from "../src/projections/unit-label";
import { openDatabase, type Database } from "../src/storage/database";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { scratchDatabase } from "./authority-fixture";
import { addLocalOrigin, advanceOrigin } from "./local-origin";
import { eventually, startStubKbbl, type AgentScript, type StubKbbl, type StubTurn } from "./stub-kbbl";

/**
 * The development workflow end to end (part 2 §1 D1, rescue spec R5): the
 * production composition with `workflow-config/development.yaml` pinned as
 * written, except that its PR watches poll every second, against a stub kbbl
 * whose agents publish through the publish route and a stub forge. Two
 * cohorts, `b` depending on `a`, with the builder starting after brief approval.
 */

const root = resolve(import.meta.dir, "../..");
const APPROVED_SPEC = "Approved specification from analysis.";
const APPROVED_ANALYSIS = { summary: "Approved analysis for spec update.", source_spec_refs: ["Goal"],
  findings: [], requirements: [{ id: "req-a", description: "Build the thing.", status: "implementable" }], risks: [], proposed_spec_updates: [
    { section: "Goal", change: "Use the approved specification.", reason: "The analysis resolved the requirement.", finding_ids: [] },
  ] };
const REVISED_ANALYSIS = { ...APPROVED_ANALYSIS, summary: "Revised analysis for spec update." };
const BODY_SCHEMAS = { spec: "text", analysis: "analysis_body", plan: "plan_body", brief: "brief_body", build_result: "build_body",
  assessment: "assessment_body", pr: "pr_body" } as const;
interface DevelopmentRunOutcome {
  readonly cohorts: readonly { readonly cohort_id: string }[];
  readonly integrations: readonly { readonly repository_key: string; readonly pr_url: string; readonly is_merged: boolean }[];
}
const VIEWER_COMPONENTS = {
  "dev-spec-analysis-viewer": "SpecAnalysisViewer",
  "dev-spec-viewer": "SpecViewer",
  "dev-plan-viewer": "PlanViewer",
  "dev-build-brief-viewer": "BuildBriefViewer",
  "dev-build-result-viewer": "BuildResultReview",
  "dev-assessment-viewer": "AssessmentReview",
  "dev-pr-summary-viewer": "PrSummaryViewer",
} as const;

/**
 * development.yaml as pinned (read through the JSON generate.ts derives from
 * it, which CI holds equal to it), with its periodic PR watches made fast
 * enough for a test.
 */
function developmentWorkflow(): Workflow {
  const text = readFileSync(resolve(root, "workflow-core/fixtures/bundles/development.json"), "utf8");
  return JSON.parse(text.replaceAll('"every": "2m"', '"every": "1s"')) as Workflow;
}

/** The url GitHub gives pull request `number` of the e2e repository. */
const pullUrl = (number: number): string => `https://github.com/oakridge-e2e/app/pull/${number}`;
const observedPrState = (body: unknown): string | null =>
  body !== null && typeof body === "object" && "state" in body && typeof body.state === "string" ? body.state : null;
/** Each branch's pull request number. */
const PULL_NUMBERS: { readonly [branch: string]: number } = { "cohort-a": 1, "cohort-b": 2, integration: 3 };

/**
 * A forge whose pull requests the agents open and the test merges, served as
 * GitHub's pull request endpoint to the production reader: what the PR
 * watches publish is what that reader makes of it.
 */
class StubForge {
  readonly pulls = new Map<number, { readonly branch: string; state: "open" | "merged" | "closed_unmerged"; readonly base: string; head_sha: string }>();
  readonly current_numbers = new Map<string, number>();
  readonly replace_on_next_open = new Set<string>();
  readonly withhold_observation = new Set<string>();
  withhold_integration_observation = false;
  open(branch: string, base: string): string {
    const current = this.current_numbers.get(branch);
    const number = this.replace_on_next_open.delete(branch) ? (PULL_NUMBERS[branch] ?? 0) + 10
      : current !== undefined && this.pulls.has(current) ? current : PULL_NUMBERS[branch] ?? 0;
    this.current_numbers.set(branch, number);
    if (!this.pulls.has(number)) this.pulls.set(number, { branch, state: "open", base, head_sha: "abc123" });
    return pullUrl(number);
  }
  merge(branch: string): void { const pull = this.pulls.get(this.current_numbers.get(branch) ?? 0); if (pull) pull.state = "merged"; }
  close(branch: string): void { const pull = this.pulls.get(this.current_numbers.get(branch) ?? 0); if (pull) pull.state = "closed_unmerged"; }
  replaceHead(branch: string, head_sha: string): void {
    const pull = this.pulls.get(this.current_numbers.get(branch) ?? 0);
    if (pull) pull.head_sha = head_sha;
  }
  /** `GET /repos/oakridge-e2e/app/pulls/:number`. */
  readonly get = (async (input: string | URL | Request) => {
    const number = Number(new URL(String(input)).pathname.split("/").at(-1));
    const pull = this.pulls.get(number);
    if (pull && (pull.branch === "integration" && this.withhold_integration_observation
      || this.withhold_observation.has(pull.branch)))
      return Response.json({ message: "temporarily unavailable" }, { status: 503 });
    if (!pull) return Response.json({ message: "Not Found" }, { status: 404 });
    return Response.json({ number, html_url: pullUrl(number),
      state: pull.state === "open" ? "open" : "closed", merged_at: pull.state === "merged" ? "2026-10-12T00:00:00Z" : null,
      head: { ref: pull.branch, sha: pull.head_sha, repo: { full_name: "oakridge-e2e/app" } }, base: { ref: pull.base } });
  }) as unknown as typeof fetch;
  readonly reader = new GithubPullRequestReader({ token: "e2e" }, this.get);
}

const workerOf = (turn: StubTurn): string => /worker `([^`]+)`/.exec(turn.preamble)?.[1] ?? "";
const memberOf = (turn: StubTurn): string => (/This task belongs to unit `([^`]+)`/.exec(turn.task)?.[1]
  ?? /on unit `([^`]+)`/.exec(turn.preamble)?.[1] ?? "").split("/").at(-1) ?? "";
const COHORTS = [{ id: "a", depends_on: [] as string[] }, { id: "b", depends_on: ["a"] }];
const dependenciesOf = (id: string): string[] => COHORTS.find((cohort) => cohort.id === id)?.depends_on ?? [];

/** The development agents: each publishes a well-formed body, and a builder or integrator opens its pull request. */
function developmentAgents(forge: StubForge, timeline: Map<string, number>): AgentScript {
  return async (turn) => {
    const member = memberOf(turn);
    const publish = async (artifact: string, body: unknown, subject: string | null = null) => {
      const response = await turn.publish(artifact, body, { predecessor: turn.predecessor(artifact), subject });
      if (!response.ok) throw new Error(`${artifact} refused: ${await response.text()}`);
    };
    switch (workerOf(turn)) {
      case "author":
        await publish("analysis", turn.predecessor("analysis") ? REVISED_ANALYSIS : APPROVED_ANALYSIS);
        break;
      case "spec_editor":
        if (!turn.task.includes("analysis for spec update")) throw new Error("spec editor did not receive the approved analysis");
        await publish("spec", APPROVED_SPEC);
        await publish("tasks", { tasks: [{ id: "task-a", description: "Build the thing.", requirement_ids: ["req-a"] }] });
        break;
      case "planner":
        if (!turn.task.includes(APPROVED_SPEC)) throw new Error("planner did not receive the approved specification");
        await publish("plan", { summary: "Two cohorts.", dependency_order: ["a", "b"], scope: { in_scope: ["thing"], out_of_scope: [] },
          acceptance_criteria: ["it works"], risks: [], cohorts: COHORTS.map((cohort) => ({ ...cohort, repository_key: "app",
            title: `Cohort ${cohort.id}`, scope: "part", description: null, files_in_scope: [],
            decisions: [{ id: "choice", text: "Use the simple implementation." }],
            acceptance_criteria: [{ id: "works", text: "it works", task_ids: ["task-a"], decision_ids: ["choice"] }] })) });
        break;
      case "writer":
        if (!turn.task.includes(APPROVED_SPEC)) throw new Error("brief writer did not receive the approved specification");
        await publish("brief", { cohort_id: member, repository_key: "app", title: `Cohort ${member}`, depends_on: dependenciesOf(member),
          goal: "Build it.", files_in_scope: [],
          decisions_made: [{ id: "choice", decision: "Use the simple implementation.", rationale: "It meets the task." }],
          approaches_rejected: [{ id: "alternative", approach: "Use a complex implementation.", reason: "Unneeded complexity.", decision_ids: ["choice"] }],
          acceptance_criteria: [{ id: "works", text: "it works", task_ids: ["task-a"], decision_ids: ["choice"] }], next_action: "build" });
        break;
      case "builder": {
        timeline.set(`build:${member}`, Date.now());
        const pr_url = forge.open(`cohort-${member}`, "develop");
        await publish("build_result", { repository_key: "app", head_sha: "abc123", summary: `Built ${member}.`, changed_files: [`${member}.ts`],
          tests: { passed: 1, failed: 0, output: null, summary: null, cargo_test_output: null }, delegated_session_metadata: null, known_issues: [] });
        await publish("pr", { pr_url, branch: `cohort-${member}`, summary: `Cohort ${member}.`, review_status: "ready" });
        break;
      }
      case "assessor":
        await publish("assessment", { head_sha: "abc123", verdict: "pass", findings: [{ criterion_id: "works", criterion: "it works", status: "met",
          evidence: [{ kind: "test", ref: "development-e2e" }], description: null }],
          test_evidence: null, recommended_next_actions: [] }, turn.subject());
        break;
      case "integrator":
        await publish("assessment", { head_sha: "abc123", verdict: "pass", findings: [{ criterion_id: null, criterion: null, status: "met",
          evidence: [{ kind: "test", ref: "integration suite", detail: "Both cohort changes pass together on the integration branch." }],
          description: "Cross-cohort integration" }],
          test_evidence: { passed: 2, failed: 0, output: null, summary: "Integration suite", cargo_test_output: null },
          recommended_next_actions: [] });
        await publish("pr", { pr_url: forge.open("integration", "main"), branch: "integration", summary: "Both cohorts.", review_status: "ready" });
        break;
      default:
        throw new Error(`no script for worker ${workerOf(turn)}`);
    }
    return "succeeded";
  };
}

let scratch: Awaited<ReturnType<typeof scratchDatabase>>;
let db: Database;
let stub: StubKbbl;
let server: ReturnType<typeof Bun.serve>;
let composition: Awaited<ReturnType<typeof createProductionComposition>>;
let base_url: string;
let repository: string;
let remote_base_head: string;
const forge = new StubForge();
const operationServices = { git: new BunGitCommandRunner(), pull_requests: forge.reader as PullRequestReader | null };
const timeline = new Map<string, number>();
const workdir = mkdtempSync(resolve(tmpdir(), "oakridge-development-agents-"));

beforeAll(async () => {
  scratch = await scratchDatabase();
  db = openDatabase(scratch.url);
  await migrateEmptyDatabase(db);
  repository = mkdtempSync(resolve(tmpdir(), "oakridge-development-repo-"));
  const git = (...args: string[]) => Bun.spawn(["git", "-C", repository, ...args]).exited;
  await git("init", "-q", "-b", "main");
  await git("-c", "user.email=e2e@oakridge.test", "-c", "user.name=e2e", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "base");
  const origin = await addLocalOrigin(repository, "git@github.com:oakridge-e2e/app.git", ["develop"]);
  remote_base_head = await advanceOrigin(origin, "develop");
  stub = startStubKbbl(developmentAgents(forge, timeline));
  let handler: (request: Request) => Response | Promise<Response> = () => new Response("starting", { status: 503 });
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => handler(request) });
  base_url = `http://127.0.0.1:${server.port}`;
  composition = await createProductionComposition({ database_url: scratch.url, host: "127.0.0.1",
    executor: { kbbl_base_url: stub.url, publication_key: "development-e2e-key", publish_base_url: base_url, agent_workdir: workdir, gated_review_url: null },
    operation_runner: createOperationRunner(operationServices),
    timing: { retry_initial_seconds: 0.05, retry_cap_seconds: 0.2, observe_interval_seconds: 0.05, max_observe_unavailable_attempts: 5, wake_timeout_seconds: 0.5 } });
  handler = composition.app.fetch;
}, 60_000);
afterAll(async () => {
  await composition.close();
  server.stop(true);
  stub.stop();
  await db.destroy();
  await scratch.drop();
  rmSync(workdir, { recursive: true, force: true });
  rmSync(repository, { recursive: true, force: true });
}, 60_000);

const api = async (method: string, path: string, body?: unknown): Promise<Response> =>
  fetch(`${base_url}${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const segment = encodeURIComponent;

/** The decision the scripted operator makes on each review, and what it does after. */
const DECISIONS: { readonly [review: string]: string } = { analysis_review: "accept", spec_review: "accept", tasks_review: "accept", plan_review: "accept", brief_review: "accept",
  assessment_review: "accept", integration_review: "accept", merge_confirmation: "confirm_merged" };
const capturedAdapterFixtures = new Set<string>();
async function captureAdapterFixture(run_id: string, name: string): Promise<void> {
  if (process.env.OAKRIDGE_CAPTURE_ADAPTER_FIXTURE !== "1" || capturedAdapterFixtures.has(name)) return;
  const capture = Bun.spawn(["bun", resolve(root, "oakridge-dbos/scripts/capture-pwa-adapter-fixtures.ts"), run_id, name], {
    env: { ...process.env, OAKRIDGE_CAPTURE_URL: base_url }, stdout: "pipe", stderr: "pipe",
  });
  const [status, stderr] = await Promise.all([capture.exited, new Response(capture.stderr).text()]);
  if (status !== 0) throw new Error(`adapter fixture capture failed: ${stderr}`);
  capturedAdapterFixtures.add(name);
}

/** Decide every review awaiting the operator once; merge a cohort's PR once its assessment is accepted. */
async function operate(run_id: string, decided: Set<string>, confirmation: "none" | "cohort" | "all" = "none",
  accept_integration = true, merged_cohorts_without_confirmation?: Set<string>, accept_assessment = true): Promise<void> {
  const units = (await db.selectFrom("authority.unit").select(["id", "parent_id", "declaration", "stage", "review_prompts", "collection_key"]).where("run_id", "=", run_id).execute())
    .map((unit) => ({ ...unit, collection_key: selectCollectionKey(unit) }));
  for (const unit of units) {
    for (const [review, awaiting] of Object.entries(unit.review_prompts)) {
      if (review === "merge_confirmation" && (confirmation === "none" || (confirmation === "cohort" && unit.stage === "integration"))) continue;
      if (review === "integration_review" && !accept_integration) continue;
      if (review === "assessment_review" && !accept_assessment) continue;
      if (review === "assessment_review" && merged_cohorts_without_confirmation) {
        const observed = await db.selectFrom("authority.artifact_revision").select("body").where("run_id", "=", run_id)
          .where("unit_id", "=", unit.id).where("artifact", "=", "pr_state").orderBy("seq", "desc").executeTakeFirst();
        if (observedPrState(observed?.body) !== "merged") { forge.merge(`cohort-${unit.collection_key}`); continue; }
        const current = await db.selectFrom("authority.unit").select("review_prompts").where("id", "=", unit.id).executeTakeFirstOrThrow();
        if ("merge_confirmation" in current.review_prompts) continue;
        merged_cohorts_without_confirmation.add(unit.collection_key ?? "");
      }
      let target = awaiting.target;
      if (review === "merge_confirmation" && unit.stage === "integration") {
        const view = await (await api("GET", `/api/runs/${segment(run_id)}/units/${segment(unit.id)}`)).json() as
          { readonly decisions: readonly { readonly submit: { readonly kind: string; readonly review?: string; readonly decision?: string;
            readonly target_revision_id?: string } }[] };
        const offered = view.decisions.find((item) => item.submit.kind === "review" && item.submit.review === review
          && item.submit.decision === "confirm_merged");
        if (!offered?.submit.target_revision_id) continue;
        target = offered.submit.target_revision_id;
      }
      const key = `${unit.id}:${review}:${target}`;
      if (decided.has(key)) continue;
      const decision = DECISIONS[review];
      if (!decision) throw new Error(`no decision for review ${review}`);
      if (review === "assessment_review") await captureAdapterFixture(run_id, "v2-adapter-sample");
      if (review === "merge_confirmation" && unit.stage === "cohort") await captureAdapterFixture(run_id, "v2-cohort-merge");
      if (review === "merge_confirmation" && unit.stage === "integration") await captureAdapterFixture(run_id, "v2-integration-merge");
      if (review === "merge_confirmation" && unit.stage === "cohort") forge.merge(`cohort-${unit.collection_key}`);
      const response = await api("POST", `/api/runs/${segment(run_id)}/units/${segment(unit.id)}/reviews/${review}/decide`,
        { request_id: crypto.randomUUID(), decision, target, payload: {} });
      if (response.status !== 201) throw new Error(`${review} on ${unit.id} refused: ${await response.text()}`);
      decided.add(key);
      if (review === "assessment_review" && confirmation === "none") { forge.merge(`cohort-${unit.collection_key}`); timeline.set(`merge:${unit.collection_key}`, Date.now()); }
      if (review === "integration_review" && confirmation === "none") forge.merge("integration");
    }
  }
}

test("D1: the development workflow runs to completion with two cohorts, b after a", async () => {
  const pinned = await api("POST", "/api/definitions", developmentWorkflow());
  if (pinned.status !== 201 && pinned.status !== 200) throw new Error(`pin refused: ${await pinned.text()}`);
  const { digest } = await pinned.json() as { readonly digest: string };
  const request_id = crypto.randomUUID();
  const launched = await api("POST", "/api/runs", { request_id, digest, input: {
    title: "Two cohorts", spec: "Build the thing in two parts.", final_merge_policy: "require_merge", primary_repository_key: "app",
    repositories: [{ key: "app", preparation: { repository_path: repository, expected_head: null },
      forge: { owner: "oakridge-e2e", name: "app", build_base: "develop", final_base: "main" } }] } });
  if (launched.status !== 201) throw new Error(`launch refused: ${await launched.text()}`);
  const run_id = launchRunId(request_id);

  const decided = new Set<string>();
  const merged_cohorts_without_confirmation = new Set<string>();
  const run = await eventually("the run to finish", async () => {
    await operate(run_id, decided, "none", true, merged_cohorts_without_confirmation);
    const row = await db.selectFrom("authority.unit").select("status").where("run_id", "=", run_id).where("id", "=", run_id).executeTakeFirstOrThrow();
    return row.status.kind === "done" ? row.status : null;
  }, 120_000);

  const units = (await db.selectFrom("authority.unit").select(["id", "parent_id", "declaration", "stage", "collection_key"]).where("run_id", "=", run_id).execute())
    .map((unit) => ({ ...unit, collection_key: selectCollectionKey(unit) }));
  const unitOf = (stage: string, member?: string) => units.find((unit) => unit.stage === stage && (member === undefined || unit.collection_key === member))?.id ?? "";
  const brief_revisions = await db.selectFrom("authority.artifact_revision").select(["unit_id", "body"])
    .where("run_id", "=", run_id).where("artifact", "=", "brief").execute();
  const cohort_inputs = await db.selectFrom("authority.unit").select(["id", "input"])
    .where("run_id", "=", run_id).where("stage", "=", "cohort").execute();
  const brief_flow = ["a", "b"].map((member) => {
    const revision = brief_revisions.find((item) => item.unit_id === unitOf("brief", member));
    const cohort_input = cohort_inputs.find((item) => item.id === unitOf("cohort", member));
    return { has_one_original: brief_revisions.filter((item) => item.unit_id === unitOf("brief", member)).length === 1,
      has_no_cohort_copy: brief_revisions.every((item) => item.unit_id !== unitOf("cohort", member)),
      is_passed_to_cohort: JSON.stringify((cohort_input?.input as { readonly brief?: unknown } | undefined)?.brief) === JSON.stringify(revision?.body) };
  });
  const schemaOf = async (unit: string, artifact: string): Promise<string> =>
    (await (await api("GET", `/api/runs/${segment(run_id)}/units/${segment(unit)}/artifacts/${artifact}`)).json() as { readonly schema: string }).schema;
  const schemas = {
    spec: await schemaOf(unitOf("analysis"), "spec"), analysis: await schemaOf(unitOf("analysis"), "analysis"),
    plan: await schemaOf(unitOf("planning"), "plan"),
    brief: await schemaOf(unitOf("brief", "a"), "brief"), build_result: await schemaOf(unitOf("cohort", "a"), "build_result"),
    assessment: await schemaOf(unitOf("cohort", "a"), "assessment"),
    integration_assessment: await schemaOf(unitOf("integration"), "assessment"), pr: await schemaOf(unitOf("integration"), "pr"),
  };
  const integration_assessment = await db.selectFrom("authority.artifact_revision").select("body")
    .where("run_id", "=", run_id).where("unit_id", "=", unitOf("integration"))
    .where("artifact", "=", "assessment").orderBy("seq", "desc").executeTakeFirst();
  const prepared_workspace = await db.selectFrom("authority.artifact_revision").select("body")
    .where("run_id", "=", run_id).where("unit_id", "=", unitOf("prepare"))
    .where("artifact", "=", "workspace").orderBy("seq", "desc").executeTakeFirst();
  const local_head = await new Response(Bun.spawn(["git", "-C", repository, "rev-parse", "HEAD"], { stdout: "pipe" }).stdout).text();
  // A watch polls every second but publishes only a change: no two successive pr_state revisions agree.
  const pr_states = await db.selectFrom("authority.artifact_revision").select(["unit_id", "body"]).where("run_id", "=", run_id)
    .where("artifact", "=", "pr_state").orderBy("created_at").execute();
  const statesOf = (unit: string): readonly string[] => pr_states.filter((revision) => revision.unit_id === unit)
    .map((revision) => JSON.stringify(revision.body));
  const isChangesOnly = (states: readonly string[]): boolean => states.length > 0 && states.every((state, index) => index === 0 || state !== states[index - 1]);
  const outcome = (run as { readonly outcome: DevelopmentRunOutcome }).outcome;
  const listed = (await (await api("GET", "/api/runs")).json() as { readonly items: readonly { readonly run_id: string; readonly title: string | null;
    readonly repository_keys: readonly string[]; readonly created_at: string; readonly updated_at: string }[] }).items.find((item) => item.run_id === run_id);
  const brief_sessions = [...stub.sessions.values()].filter((session) => session.spec.initial_prompt.includes(`of run \`${run_id}\``)
    && session.spec.initial_prompt.includes("worker `writer`"));
  const early_session_workspaces = ["author", "spec_editor", "planner", "writer"].map((worker) => {
    const sessions = stub.sessionsFor((session) => session.spec.initial_prompt.includes(`of run \`${run_id}\``)
      && session.spec.initial_prompt.includes(`worker \`${worker}\``));
    return sessions.map((session) => [session.spec.workdir, session.spec.worktree?.base_ref]);
  });
  const analysis_and_plan_prompts_omit_checkout = ["author", "planner"].every((worker) =>
    stub.sessionsFor((session) => session.spec.initial_prompt.includes(`of run \`${run_id}\``)
      && session.spec.initial_prompt.includes(`worker \`${worker}\``))
      .every((session) => session.inputs.every((input) => !input.text.includes(repository))));
  await eventually("brief session closed after both reviews", async () => brief_sessions.length === 1 && brief_sessions[0]?.status === "ended");
  expect({
    cohorts: outcome.cohorts.map((cohort) => cohort.cohort_id),
    brief_flow,
    integrations: outcome.integrations,
    b_built_after_a_merged: (timeline.get("build:b") ?? 0) >= (timeline.get("merge:a") ?? Infinity),
    schemas,
    integration_assessment: integration_assessment?.body,
    pr_states_change: [unitOf("cohort", "a"), unitOf("cohort", "b"), unitOf("integration")].map((unit) => isChangesOnly(statesOf(unit))),
    merged_cohorts_without_confirmation: [...merged_cohorts_without_confirmation].sort(),
    run_summary: [listed?.title, listed?.repository_keys, !!listed && listed.updated_at >= listed.created_at],
    brief_sessions: brief_sessions.map((session) => [session.inputs.length, session.status]),
    early_session_workspaces,
    analysis_and_plan_prompts_omit_checkout,
    prepared_head_vs_checkout: [(prepared_workspace?.body as { readonly head?: string } | undefined)?.head, remote_base_head !== local_head.trim()],
  }).toEqual({
    cohorts: ["a", "b"],
    brief_flow: ["a", "b"].map(() => ({ has_one_original: true, has_no_cohort_copy: true, is_passed_to_cohort: true })),
    integrations: [{ repository_key: "app", pr_url: pullUrl(3), is_merged: true }],
    b_built_after_a_merged: true,
    schemas: { ...BODY_SCHEMAS, integration_assessment: "assessment_body" },
    integration_assessment: { head_sha: "abc123", verdict: "pass", findings: [{ criterion_id: null, criterion: null, status: "met",
      evidence: [{ kind: "test", ref: "integration suite", detail: "Both cohort changes pass together on the integration branch." }],
      description: "Cross-cohort integration" }],
    test_evidence: { passed: 2, failed: 0, output: null, summary: "Integration suite", cargo_test_output: null },
    recommended_next_actions: [] },
    pr_states_change: [true, true, true],
    merged_cohorts_without_confirmation: ["a", "b"],
    run_summary: ["Two cohorts", ["app"], true],
    brief_sessions: [[2, "ended"]],
    early_session_workspaces: ["author", "spec_editor", "planner", "writer"].map(() => [[repository, "origin/develop"]]),
    analysis_and_plan_prompts_omit_checkout: true,
    prepared_head_vs_checkout: [remote_base_head, true],
  });
}, 150_000);

test("analysis, spec, and tasks need approval after joint republication", async () => {
  const pinned = await api("POST", "/api/definitions", developmentWorkflow());
  if (!pinned.ok) throw new Error(`pin refused: ${await pinned.text()}`);
  const { digest } = await pinned.json() as { readonly digest: string };
  const request_id = crypto.randomUUID();
  const launched = await api("POST", "/api/runs", { request_id, digest, input: {
    title: "Analysis handoff", spec: "Original specification.", final_merge_policy: "require_merge", primary_repository_key: "app",
    repositories: [{ key: "app", preparation: { repository_path: repository, expected_head: null },
      forge: { owner: "oakridge-e2e", name: "app", build_base: "develop", final_base: "main" } }] } });
  if (launched.status !== 201) throw new Error(`launch refused: ${await launched.text()}`);
  const run_id = launchRunId(request_id);
  const unit_id = `${run_id}/analysis`;
  const reviewTarget = async (): Promise<string | null> => {
    const unit = await db.selectFrom("authority.unit").select("review_prompts").where("id", "=", unit_id).executeTakeFirst();
    return unit?.review_prompts.analysis_review?.target ?? null;
  };
  const revisionCount = async (artifact: string): Promise<number> => {
    const rows = await db.selectFrom("authority.artifact_revision").select("id").where("run_id", "=", run_id)
      .where("unit_id", "=", unit_id).where("artifact", "=", artifact).execute();
    return rows.length;
  };
  const first = await eventually("first analysis review", reviewTarget);
  expect([await revisionCount("analysis"), await revisionCount("spec"), await revisionCount("tasks")]).toEqual([1, 0, 0]);
  const change = await api("POST", `/api/runs/${segment(run_id)}/units/${segment(unit_id)}/reviews/analysis_review/decide`,
    { request_id: crypto.randomUUID(), decision: "request_changes", target: first, payload: { feedback: "Clarify the finding." } });
  expect(change.status).toBe(201);
  const revised = await eventually("revised analysis review", async () => {
    const target = await reviewTarget();
    return target && target !== first ? target : null;
  });
  expect([await revisionCount("analysis"), await revisionCount("spec"), await revisionCount("tasks")]).toEqual([2, 0, 0]);
  const accepted = await api("POST", `/api/runs/${segment(run_id)}/units/${segment(unit_id)}/reviews/analysis_review/decide`,
    { request_id: crypto.randomUUID(), decision: "accept", target: revised, payload: {} });
  expect(accepted.status).toBe(201);
  await eventually("spec and tasks publication", async () =>
    await revisionCount("spec") === 1 && await revisionCount("tasks") === 1 ? true : null);
  const specTarget = await eventually("revised spec review", async () => {
    const unit = await db.selectFrom("authority.unit").select("review_prompts").where("id", "=", unit_id).executeTakeFirst();
    return unit?.review_prompts.spec_review?.target ?? null;
  });
  const beforeSpecApproval = await db.selectFrom("authority.unit").select("status").where("id", "=", `${run_id}/planning`).executeTakeFirst();
  expect(beforeSpecApproval?.status.kind).toBe("not_started");
  const specChange = await api("POST", `/api/runs/${segment(run_id)}/units/${segment(unit_id)}/reviews/spec_review/decide`,
    { request_id: crypto.randomUUID(), decision: "request_changes", target: specTarget, payload: { feedback: "Clarify the approved edit." } });
  expect(specChange.status).toBe(201);
  const revisedSpecTarget = await eventually("revised spec review after changes", async () => {
    const unit = await db.selectFrom("authority.unit").select("review_prompts").where("id", "=", unit_id).executeTakeFirst();
    const target = unit?.review_prompts.spec_review?.target;
    return target && target !== specTarget ? target : null;
  });
  expect([await revisionCount("spec"), await revisionCount("tasks")]).toEqual([2, 2]);
  const specAccepted = await api("POST", `/api/runs/${segment(run_id)}/units/${segment(unit_id)}/reviews/spec_review/decide`,
    { request_id: crypto.randomUUID(), decision: "accept", target: revisedSpecTarget, payload: {} });
  expect(specAccepted.status).toBe(201);
  const tasksTarget = await eventually("tasks review", async () => {
    const unit = await db.selectFrom("authority.unit").select("review_prompts").where("id", "=", unit_id).executeTakeFirst();
    return unit?.review_prompts.tasks_review?.target ?? null;
  });
  const beforeTasksApproval = await db.selectFrom("authority.unit").select("status").where("id", "=", `${run_id}/planning`).executeTakeFirst();
  expect(beforeTasksApproval?.status.kind).toBe("not_started");
  const tasksChange = await api("POST", `/api/runs/${segment(run_id)}/units/${segment(unit_id)}/reviews/tasks_review/decide`,
    { request_id: crypto.randomUUID(), decision: "request_changes", target: tasksTarget, payload: { feedback: "Clarify the task." } });
  expect(tasksChange.status).toBe(201);
  const revisedTasksTarget = await eventually("revised tasks review", async () => {
    const unit = await db.selectFrom("authority.unit").select("review_prompts").where("id", "=", unit_id).executeTakeFirst();
    const target = unit?.review_prompts.tasks_review?.target;
    return target && target !== tasksTarget ? target : null;
  });
  expect([await revisionCount("spec"), await revisionCount("tasks")]).toEqual([3, 3]);
  const republishedSpecTarget = await eventually("spec review after task changes", async () => {
    const unit = await db.selectFrom("authority.unit").select("review_prompts").where("id", "=", unit_id).executeTakeFirst();
    const target = unit?.review_prompts.spec_review?.target;
    return target && target !== revisedSpecTarget ? target : null;
  });
  const specReaccepted = await api("POST", `/api/runs/${segment(run_id)}/units/${segment(unit_id)}/reviews/spec_review/decide`,
    { request_id: crypto.randomUUID(), decision: "accept", target: republishedSpecTarget, payload: {} });
  expect(specReaccepted.status).toBe(201);
  const tasksAccepted = await api("POST", `/api/runs/${segment(run_id)}/units/${segment(unit_id)}/reviews/tasks_review/decide`,
    { request_id: crypto.randomUUID(), decision: "accept", target: revisedTasksTarget, payload: {} });
  expect(tasksAccepted.status).toBe(201);
  const planning = await eventually("planning input", async () => {
    const unit = await db.selectFrom("authority.unit").select("input").where("id", "=", `${run_id}/planning`).executeTakeFirst();
    return unit?.input && typeof unit.input === "object" && "spec" in unit.input ? unit.input : null;
  });
  expect(planning.spec).toBe(APPROVED_SPEC);
  expect("tasks" in planning ? planning.tasks : null).toEqual({ tasks: [{ id: "task-a", description: "Build the thing.", requirement_ids: ["req-a"] }] });
  await api("POST", `/api/runs/${segment(run_id)}/cancel`, { request_id: crypto.randomUUID() });
}, 90_000);

test("manual confirmation completes the development run with no PR reader", async () => {
  forge.pulls.clear();
  operationServices.pull_requests = null;
  const pinned = await api("POST", "/api/definitions", developmentWorkflow());
  if (!pinned.ok) throw new Error(`pin refused: ${await pinned.text()}`);
  const { digest } = await pinned.json() as { readonly digest: string };
  const request_id = crypto.randomUUID();
  const launched = await api("POST", "/api/runs", { request_id, digest, input: {
    title: "Confirm PRs", spec: "Confirm both PR stages.", final_merge_policy: "require_merge", primary_repository_key: "app",
    repositories: [{ key: "app", preparation: { repository_path: repository, expected_head: null },
      forge: { owner: "oakridge-e2e", name: "app", build_base: "develop", final_base: "main" } }] } });
  if (launched.status !== 201) throw new Error(`launch refused: ${await launched.text()}`);
  const run_id = launchRunId(request_id);
  const decided = new Set<string>();
  const integration = await eventually("integration PR to publish", async () => {
    await operate(run_id, decided, "cohort", false);
    const unit = await db.selectFrom("authority.unit").select(["id", "status"]).where("run_id", "=", run_id)
      .where("stage", "=", "integration").executeTakeFirst();
    if (!unit) return null;
    const pr = await db.selectFrom("authority.artifact_revision").select("id").where("run_id", "=", run_id)
      .where("unit_id", "=", unit.id).where("artifact", "=", "pr").executeTakeFirst();
    return pr ? unit : null;
  }, 120_000);
  const before = await eventually("integration manual merge confirmation", async () => {
    const view = await (await api("GET", `/api/runs/${segment(run_id)}/units/${segment(integration.id)}`)).json() as
      { readonly decisions: readonly { readonly key: string; readonly submit: { readonly target_revision_id?: string } }[];
        readonly attempts: readonly { readonly worker: string; readonly failure: { readonly code: string } | null }[] };
    const failure = view.attempts.find((attempt) => attempt.worker === "pr_watch" && attempt.failure?.code === "discovery_unsupported");
    return failure ? view.decisions.find((decision) => decision.key === "confirm_merged") ?? null : null;
  }, 120_000);
  const unseen = await db.selectFrom("authority.artifact_revision").select("id").where("run_id", "=", run_id)
    .where("unit_id", "=", integration.id).where("artifact", "=", "pr_state").executeTakeFirst();
  expect({ observed: !!unseen, manual_target: before.submit.target_revision_id?.includes(":manual_merge_target:") })
    .toEqual({ observed: false, manual_target: true });

  const live_status = await api("GET", `/api/runs/${segment(run_id)}/units/${segment(integration.id)}/merge-status`);
  const status_body = await live_status.json() as { readonly kind: string; readonly detail?: string };
  expect({ status: live_status.status, kind: status_body.kind, reader_unavailable: status_body.detail?.includes("no pull request reader") })
    .toEqual({ status: 200, kind: "unavailable", reader_unavailable: true });

  operationServices.pull_requests = forge.reader;
  try {
    const open_status = await api("GET", `/api/runs/${segment(run_id)}/units/${segment(integration.id)}/merge-status`);
    expect({ status: open_status.status, body: await open_status.json() }).toEqual({ status: 200,
      body: { kind: "not_merged", pr_url: pullUrl(3), state: "open" } });
  } finally { operationServices.pull_requests = null; }

  forge.merge("integration");

  const completed = await eventually("the confirmed run to finish", async () => {
    await operate(run_id, decided, "all");
    const root = await db.selectFrom("authority.unit").select("status").where("id", "=", run_id).executeTakeFirstOrThrow();
    return root.status.kind === "done" ? root.status : null;
  }, 120_000);
  const outcome = (completed as { readonly outcome: DevelopmentRunOutcome }).outcome;
  const confirmations = await db.selectFrom("authority.review_decision").select(["unit_id", "target_revision_id"])
    .where("run_id", "=", run_id).where("review", "=", "merge_confirmation").execute();
  const units = await db.selectFrom("authority.unit").select(["id", "stage", "status", "review_prompts"])
    .where("run_id", "=", run_id).execute();
  const cohorts = units.filter((unit) => unit.stage === "cohort");
  const integration_state = units.find((unit) => unit.id === integration.id);
  expect({ confirmations: confirmations.length, cohort_done: cohorts.every((unit) => unit.status.kind === "done"),
    integration_done: integration_state?.status.kind, confirmation_offered: units.some((unit) => "merge_confirmation" in unit.review_prompts),
    integration_target: confirmations.find((decision) => decision.unit_id === integration.id)?.target_revision_id.includes(":manual_merge_target:"),
    integrations: outcome.integrations })
    .toEqual({ confirmations: 3, cohort_done: true, integration_done: "done", confirmation_offered: false, integration_target: true,
      integrations: [{ repository_key: "app", pr_url: pullUrl(3), is_merged: true }] });
}, 150_000);

test("a replacement cohort PR ignores the previous PR's closed observation", async () => {
  forge.pulls.clear();
  operationServices.pull_requests = forge.reader;
  const pinned = await api("POST", "/api/definitions", developmentWorkflow());
  if (!pinned.ok) throw new Error(`pin refused: ${await pinned.text()}`);
  const { digest } = await pinned.json() as { readonly digest: string };
  const request_id = crypto.randomUUID();
  const launched = await api("POST", "/api/runs", { request_id, digest, input: {
    title: "Replace cohort PR", spec: "Require the current cohort PR.", final_merge_policy: "require_merge", primary_repository_key: "app",
    repositories: [{ key: "app", preparation: { repository_path: repository, expected_head: null },
      forge: { owner: "oakridge-e2e", name: "app", build_base: "develop", final_base: "main" } }] } });
  if (launched.status !== 201) throw new Error(`launch refused: ${await launched.text()}`);
  const run_id = launchRunId(request_id);
  const decided = new Set<string>();
  const cohort = await eventually("cohort PR to be observed open", async () => {
    await operate(run_id, decided, "none", false, undefined, false);
    const unit = await db.selectFrom("authority.unit").select("id").where("run_id", "=", run_id)
      .where("stage", "=", "cohort").where("collection_key", "=", "a").executeTakeFirst();
    if (!unit) return null;
    const observed = await db.selectFrom("authority.artifact_revision").select("body").where("run_id", "=", run_id)
      .where("unit_id", "=", unit.id).where("artifact", "=", "pr_state").orderBy("seq", "desc").executeTakeFirst();
    return observedPrState(observed?.body) === "open" ? unit : null;
  }, 120_000);
  forge.close("cohort-a");
  const closed = await eventually("closed cohort PR and copied state", async () => {
    const revisions = await db.selectFrom("authority.artifact_revision").select(["artifact", "body"])
      .where("run_id", "=", run_id).where("unit_id", "=", cohort.id)
      .where("artifact", "in", ["pr_state", "observed_state"]).orderBy("seq", "desc").execute();
    if (!revisions.some((revision) => revision.artifact === "observed_state" && observedPrState(revision.body) === "closed_unmerged")) return null;
    const unit = await db.selectFrom("authority.unit").select("review_prompts").where("id", "=", cohort.id).executeTakeFirstOrThrow();
    return unit.review_prompts.pr_closed ?? null;
  }, 120_000);
  forge.replace_on_next_open.add("cohort-a");
  forge.withhold_observation.add("cohort-a");
  const submitted = await api("POST", `/api/runs/${segment(run_id)}/units/${segment(cohort.id)}/reviews/pr_closed/decide`,
    { request_id: crypto.randomUUID(), decision: "replace_pr", target: closed.target,
      payload: { feedback: "Open a replacement cohort PR." } });
  expect(submitted.status).toBe(201);
  const replacement = await eventually("replacement cohort PR to publish", async () => {
    const revisions = await db.selectFrom("authority.artifact_revision").select(["artifact", "body"])
      .where("run_id", "=", run_id).where("unit_id", "=", cohort.id)
      .where("artifact", "in", ["pr", "pr_state", "observed_state"]).orderBy("seq", "desc").execute();
    const latest = (artifact: string): unknown => revisions.find((revision) => revision.artifact === artifact)?.body;
    const pr = latest("pr") as { readonly pr_url?: string } | undefined;
    if (pr?.pr_url !== pullUrl(11)) return null;
    const unit = await db.selectFrom("authority.unit").select("review_prompts").where("id", "=", cohort.id).executeTakeFirstOrThrow();
    return { old_state: latest("pr_state"), old_observed: latest("observed_state"),
      has_closed_review: "pr_closed" in unit.review_prompts };
  }, 120_000);
  expect(replacement).toMatchObject({ old_state: { url: pullUrl(1), state: "closed_unmerged" },
    old_observed: { url: pullUrl(1), state: "closed_unmerged" }, has_closed_review: false });
  forge.withhold_observation.delete("cohort-a");
  const cancelled = await api("POST", `/api/runs/${segment(run_id)}/cancel`, { request_id: crypto.randomUUID() });
  expect(cancelled.status).toBe(201);
}, 150_000);

test("a closed unmerged integration PR asks for replacement, not merge confirmation", async () => {
  forge.pulls.clear();
  operationServices.pull_requests = forge.reader;
  forge.withhold_integration_observation = false;
  const pinned = await api("POST", "/api/definitions", developmentWorkflow());
  if (!pinned.ok) throw new Error(`pin refused: ${await pinned.text()}`);
  const { digest } = await pinned.json() as { readonly digest: string };
  const request_id = crypto.randomUUID();
  const launched = await api("POST", "/api/runs", { request_id, digest, input: {
    title: "Replace closed PR", spec: "Require a merged integration PR.", final_merge_policy: "require_merge", primary_repository_key: "app",
    repositories: [{ key: "app", preparation: { repository_path: repository, expected_head: null },
      forge: { owner: "oakridge-e2e", name: "app", build_base: "develop", final_base: "main" } }] } });
  if (launched.status !== 201) throw new Error(`launch refused: ${await launched.text()}`);
  const run_id = launchRunId(request_id);
  const decided = new Set<string>();
  const integration = await eventually("integration PR to be observed open", async () => {
    await operate(run_id, decided, "none", false);
    const unit = await db.selectFrom("authority.unit").select("id").where("run_id", "=", run_id)
      .where("stage", "=", "integration").executeTakeFirst();
    if (!unit) return null;
    const observed = await db.selectFrom("authority.artifact_revision").select("body").where("run_id", "=", run_id)
      .where("unit_id", "=", unit.id).where("artifact", "=", "pr_state").executeTakeFirst();
    return observedPrState(observed?.body) === "open" ? unit : null;
  }, 120_000);
  forge.close("integration");
  const closed = await eventually("closed integration PR to be observed", async () => {
    const observed = await db.selectFrom("authority.artifact_revision").select("body").where("run_id", "=", run_id)
      .where("unit_id", "=", integration.id).where("artifact", "=", "pr_state").orderBy("seq", "desc").executeTakeFirst();
    if (observedPrState(observed?.body) !== "closed_unmerged") return null;
    const copied = await db.selectFrom("authority.artifact_revision").select("body").where("run_id", "=", run_id)
      .where("unit_id", "=", integration.id).where("artifact", "=", "observed_state").orderBy("seq", "desc").executeTakeFirst();
    if (observedPrState(copied?.body) !== "closed_unmerged") return null;
    const unit = await db.selectFrom("authority.unit").select(["status", "review_prompts"]).where("id", "=", integration.id).executeTakeFirstOrThrow();
    const view = await (await api("GET", `/api/runs/${segment(run_id)}/units/${segment(integration.id)}`)).json() as
      { readonly decisions: readonly { readonly key: string; readonly fields: readonly { readonly key: string }[];
        readonly submit: { readonly kind: string; readonly review?: string; readonly decision?: string;
          readonly effect?: string; readonly target_revision_id?: string } }[] };
    const replacement = view.decisions.find((decision) => decision.key === "replace_pr" && decision.submit.review === "pr_closed");
    return replacement ? { status: unit.status.kind, confirmation_offered: "merge_confirmation" in unit.review_prompts,
      feedback_field: replacement.fields.map((field) => field.key), effect: replacement.submit.effect,
      decision: replacement.submit.decision, target: replacement.submit.target_revision_id } : null;
  }, 120_000);
  expect(closed).toMatchObject({ status: "active", confirmation_offered: false,
    feedback_field: ["feedback"], effect: "request_changes" });
  forge.replace_on_next_open.add("integration");
  forge.withhold_integration_observation = true;
  const submitted = await api("POST", `/api/runs/${segment(run_id)}/units/${segment(integration.id)}/reviews/pr_closed/decide`,
    { request_id: crypto.randomUUID(), decision: closed.decision, target: closed.target,
      payload: { feedback: "Open a replacement PR for the integration." } });
  expect(submitted.status).toBe(201);
  const replacement = await eventually("replacement integration PR to publish", async () => {
    const revisions = await db.selectFrom("authority.artifact_revision").select(["artifact", "body"])
      .where("run_id", "=", run_id).where("unit_id", "=", integration.id)
      .where("artifact", "in", ["pr", "pr_state", "observed_state"])
      .orderBy("seq", "desc").execute();
    const latest = (artifact: string): unknown => revisions.find((revision) => revision.artifact === artifact)?.body;
    const pr = latest("pr") as { readonly pr_url?: string } | undefined;
    if (pr?.pr_url !== pullUrl(13)) return null;
    const unit = await db.selectFrom("authority.unit").select("review_prompts").where("id", "=", integration.id)
      .executeTakeFirstOrThrow();
    return { old_state: latest("pr_state"), old_observed: latest("observed_state"),
      has_closed_review: "pr_closed" in unit.review_prompts };
  }, 120_000);
  expect(replacement).toMatchObject({ old_state: { url: pullUrl(3), state: "closed_unmerged" },
    old_observed: { url: pullUrl(3), state: "closed_unmerged" }, has_closed_review: false });
  const stale_decision = await api("POST", `/api/runs/${segment(run_id)}/units/${segment(integration.id)}/reviews/pr_closed/decide`,
    { request_id: crypto.randomUUID(), decision: closed.decision, target: closed.target,
      payload: { feedback: "The old PR was closed." } });
  expect(stale_decision.status).toBe(409);
  forge.withhold_integration_observation = false;
  const cancelled = await api("POST", `/api/runs/${segment(run_id)}/cancel`, { request_id: crypto.randomUUID() });
  expect(cancelled.status).toBe(201);
  await eventually("replacement test run to cancel", async () => {
    const root = await db.selectFrom("authority.unit").select("status").where("id", "=", run_id).executeTakeFirstOrThrow();
    return root.status.kind === "cancelled" ? true : null;
  });
}, 150_000);

test("an old integration PR merge cannot complete a replacement PR", async () => {
  forge.pulls.clear();
  operationServices.pull_requests = forge.reader;
  const pinned = await api("POST", "/api/definitions", developmentWorkflow());
  if (!pinned.ok) throw new Error(`pin refused: ${await pinned.text()}`);
  const { digest } = await pinned.json() as { readonly digest: string };
  const request_id = crypto.randomUUID();
  const launched = await api("POST", "/api/runs", { request_id, digest, input: {
    title: "Replace merged integration PR", spec: "Do not reuse an old merge.", final_merge_policy: "require_merge", primary_repository_key: "app",
    repositories: [{ key: "app", preparation: { repository_path: repository, expected_head: null },
      forge: { owner: "oakridge-e2e", name: "app", build_base: "develop", final_base: "main" } }] } });
  if (launched.status !== 201) throw new Error(`launch refused: ${await launched.text()}`);
  const run_id = launchRunId(request_id);
  const decided = new Set<string>();
  const integration = await eventually("integration PR to publish", async () => {
    await operate(run_id, decided, "cohort", false);
    const unit = await db.selectFrom("authority.unit").select("id").where("run_id", "=", run_id)
      .where("stage", "=", "integration").executeTakeFirst();
    if (!unit) return null;
    const pr = await db.selectFrom("authority.artifact_revision").select("id").where("run_id", "=", run_id)
      .where("unit_id", "=", unit.id).where("artifact", "=", "pr").executeTakeFirst();
    return pr ? unit : null;
  }, 120_000);
  forge.merge("integration");
  const old_review = await eventually("old integration merge to be copied", async () => {
    const copied = await db.selectFrom("authority.artifact_revision").select("body").where("run_id", "=", run_id)
      .where("unit_id", "=", integration.id).where("artifact", "=", "observed_state").orderBy("seq", "desc").executeTakeFirst();
    if (observedPrState(copied?.body) !== "merged") return null;
    const unit = await db.selectFrom("authority.unit").select("review_prompts").where("id", "=", integration.id).executeTakeFirstOrThrow();
    return unit.review_prompts.integration_review ?? null;
  }, 120_000);
  forge.replace_on_next_open.add("integration");
  forge.withhold_integration_observation = true;
  const requested = await api("POST", `/api/runs/${segment(run_id)}/units/${segment(integration.id)}/reviews/integration_review/decide`,
    { request_id: crypto.randomUUID(), decision: "request_changes", target: old_review.target,
      payload: { feedback: "Open a new integration PR." } });
  expect(requested.status).toBe(201);
  const replacement = await eventually("replacement integration PR to publish", async () => {
    const pr = await db.selectFrom("authority.artifact_revision").select("body").where("run_id", "=", run_id)
      .where("unit_id", "=", integration.id).where("artifact", "=", "pr").orderBy("seq", "desc").executeTakeFirst();
    return (pr?.body as { readonly pr_url?: string } | undefined)?.pr_url === pullUrl(13) ? true : null;
  }, 120_000);
  expect(replacement).toBe(true);
  await eventually("replacement integration review", async () => {
    await operate(run_id, decided, "cohort");
    const decision = await db.selectFrom("authority.review_decision").select("id").where("run_id", "=", run_id)
      .where("unit_id", "=", integration.id).where("review", "=", "integration_review")
      .where("decision", "=", "accept").executeTakeFirst();
    return decision ? true : null;
  }, 120_000);
  const unit = await db.selectFrom("authority.unit").select("status").where("id", "=", integration.id).executeTakeFirstOrThrow();
  const copied = await db.selectFrom("authority.artifact_revision").select("body").where("run_id", "=", run_id)
    .where("unit_id", "=", integration.id).where("artifact", "=", "observed_state").orderBy("seq", "desc").executeTakeFirst();
  expect({ status: unit.status.kind, old_state: copied?.body })
    .toMatchObject({ status: "active", old_state: { url: pullUrl(3), state: "merged" } });
  forge.withhold_integration_observation = false;
  const cancelled = await api("POST", `/api/runs/${segment(run_id)}/cancel`, { request_id: crypto.randomUUID() });
  expect(cancelled.status).toBe(201);
}, 150_000);

test("allow_close_without_merge completes on an observed close without claiming a merge", async () => {
  forge.pulls.clear();
  operationServices.pull_requests = forge.reader;
  forge.withhold_integration_observation = false;
  const pinned = await api("POST", "/api/definitions", developmentWorkflow());
  if (!pinned.ok) throw new Error(`pin refused: ${await pinned.text()}`);
  const { digest } = await pinned.json() as { readonly digest: string };
  const request_id = crypto.randomUUID();
  const launched = await api("POST", "/api/runs", { request_id, digest, input: {
    title: "Allow closed PR", spec: "Complete after an unmerged close.", final_merge_policy: "allow_close_without_merge", primary_repository_key: "app",
    repositories: [{ key: "app", preparation: { repository_path: repository, expected_head: null },
      forge: { owner: "oakridge-e2e", name: "app", build_base: "develop", final_base: "main" } }] } });
  if (launched.status !== 201) throw new Error(`launch refused: ${await launched.text()}`);
  const run_id = launchRunId(request_id);
  const decided = new Set<string>();
  await eventually("integration PR to publish", async () => {
    await operate(run_id, decided, "cohort", false);
    return forge.pulls.has(PULL_NUMBERS.integration) ? true : null;
  }, 120_000);
  forge.close("integration");
  const completed = await eventually("closed PR to complete the run", async () => {
    await operate(run_id, decided, "cohort");
    const root = await db.selectFrom("authority.unit").select("status").where("id", "=", run_id).executeTakeFirstOrThrow();
    return root.status.kind === "done" ? root.status : null;
  }, 120_000);
  expect((completed as { readonly outcome: DevelopmentRunOutcome }).outcome.integrations)
    .toEqual([{ repository_key: "app", pr_url: pullUrl(3), is_merged: false }]);
}, 150_000);

test("development artifact schemas and PWA viewer component IDs align", () => {
  // The spec uses the built-in text schema; the other bodies use named schemas.
  // Read the registry as text rather than importing across the PWA boundary.
  const registry = readFileSync(resolve(root, "kbbl/core/pwa/oakridge/artifactRegistry.tsx"), "utf8");
  const workflow = developmentWorkflow();
  const declared = [workflow.stages.analysis?.artifacts.spec?.schema,
    ...Object.values(BODY_SCHEMAS).filter((name) => name !== BODY_SCHEMAS.spec && workflow.schemas?.[name] !== undefined)];
  const registered = Object.entries(VIEWER_COMPONENTS).filter(([componentId, viewer]) =>
    registry.includes(`"${componentId}": { Viewer: ${viewer} }`));
  expect({ declared, registered }).toEqual({
    declared: Object.values(BODY_SCHEMAS),
    registered: Object.entries(VIEWER_COMPONENTS),
  });
});
