import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Workflow } from "../src/core-client/core-types";
import { createOperationRunner } from "../src/operations/runner";
import { GithubPullRequestReader } from "../src/runtime/github-pull-requests";
import { createProductionComposition } from "../src/runtime/compose";
import { BunGitCommandRunner } from "../src/runtime/git-command-runner";
import { launchRunId } from "../src/storage/commit";
import { selectCollectionKey } from "../src/projections/unit-label";
import { openDatabase, type Database } from "../src/storage/database";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { scratchDatabase } from "./authority-fixture";
import { eventually, startStubKbbl, type AgentScript, type StubKbbl, type StubTurn } from "./stub-kbbl";

/**
 * The development workflow end to end (part 2 §1 D1, rescue spec R5): the
 * production composition with `workflow-config/development.yaml` pinned as
 * written, except that its PR watches poll every second, against a stub kbbl
 * whose agents publish through the publish route and a stub forge. Two
 * cohorts, `b` depending on `a`, with admission on.
 */

const root = resolve(import.meta.dir, "../..");
const BODY_SCHEMAS = { analysis: "analysis_body", plan: "plan_body", brief: "brief_body", build_result: "build_body",
  assessment: "assessment_body", pr: "pr_body" } as const;
const VIEWER_COMPONENTS = {
  "dev-spec-analysis-viewer": "SpecAnalysisViewer",
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
/** Each branch's pull request number. */
const PULL_NUMBERS: { readonly [branch: string]: number } = { "cohort-a": 1, "cohort-b": 2, integration: 3 };

/**
 * A forge whose pull requests the agents open and the test merges, served as
 * GitHub's pull request endpoint to the production reader: what the PR
 * watches publish is what that reader makes of it.
 */
class StubForge {
  readonly pulls = new Map<number, { readonly branch: string; state: "open" | "merged"; readonly base: string }>();
  open(branch: string, base: string): string {
    const number = PULL_NUMBERS[branch] ?? 0;
    if (!this.pulls.has(number)) this.pulls.set(number, { branch, state: "open", base });
    return pullUrl(number);
  }
  merge(branch: string): void { const pull = this.pulls.get(PULL_NUMBERS[branch] ?? 0); if (pull) pull.state = "merged"; }
  /** `GET /repos/oakridge-e2e/app/pulls/:number`. */
  readonly get = (async (input: string | URL | Request) => {
    const number = Number(new URL(String(input)).pathname.split("/").at(-1));
    const pull = this.pulls.get(number);
    if (!pull) return Response.json({ message: "Not Found" }, { status: 404 });
    return Response.json({ number, html_url: pullUrl(number),
      state: pull.state === "merged" ? "closed" : "open", merged_at: pull.state === "merged" ? "2026-10-12T00:00:00Z" : null,
      head: { ref: pull.branch, sha: "abc123", repo: { full_name: "oakridge-e2e/app" } }, base: { ref: pull.base } });
  }) as unknown as typeof fetch;
  readonly reader = new GithubPullRequestReader({ token: "e2e" }, this.get);
}

const workerOf = (turn: StubTurn): string => /worker `([^`]+)`/.exec(turn.preamble)?.[1] ?? "";
const memberOf = (turn: StubTurn): string => (/on unit `([^`]+)`/.exec(turn.preamble)?.[1] ?? "").split("/").at(-1) ?? "";
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
        await publish("analysis", { summary: "Feasible.", source_spec_refs: ["§1"], findings: [],
          requirements: [{ id: "r1", description: "Do the thing.", status: "implementable" }], risks: [] });
        break;
      case "planner":
        await publish("plan", { summary: "Two cohorts.", dependency_order: ["a", "b"], scope: { in_scope: ["thing"], out_of_scope: [] },
          acceptance_criteria: ["it works"], risks: [], cohorts: COHORTS.map((cohort) => ({ ...cohort, repository_key: "app",
            title: `Cohort ${cohort.id}`, scope: "part", description: null, files_in_scope: [], decisions: [], acceptance_criteria: ["it works"] })) });
        break;
      case "writer":
        await publish("brief", { cohort_id: member, repository_key: "app", title: `Cohort ${member}`, depends_on: dependenciesOf(member),
          goal: "Build it.", files_in_scope: [], decisions_made: [], approaches_rejected: [], acceptance_criteria: ["it works"], next_action: "build" });
        break;
      case "builder": {
        timeline.set(`build:${member}`, Date.now());
        const pr_url = forge.open(`cohort-${member}`, "develop");
        await publish("build_result", { repository_key: "app", summary: `Built ${member}.`, changed_files: [`${member}.ts`],
          tests: { passed: 1, failed: 0, output: null, summary: null, cargo_test_output: null }, delegated_session_metadata: null, known_issues: [] });
        await publish("pr", { pr_url, branch: `cohort-${member}`, summary: `Cohort ${member}.`, review_status: "ready" });
        break;
      }
      case "assessor":
        await publish("assessment", { verdict: "pass", findings: [{ criterion: "it works", status: "met", evidence: "tests", description: null }],
          test_evidence: null, recommended_next_actions: [] }, turn.subject());
        break;
      case "integrator":
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
const forge = new StubForge();
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
  await git("remote", "add", "origin", "git@github.com:oakridge-e2e/app.git");
  stub = startStubKbbl(developmentAgents(forge, timeline));
  let handler: (request: Request) => Response | Promise<Response> = () => new Response("starting", { status: 503 });
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => handler(request) });
  base_url = `http://127.0.0.1:${server.port}`;
  composition = await createProductionComposition({ database_url: scratch.url, host: "127.0.0.1",
    executor: { kbbl_base_url: stub.url, publication_key: "development-e2e-key", publish_base_url: base_url, agent_workdir: workdir, github_token: null },
    operation_runner: createOperationRunner({ git: new BunGitCommandRunner(), pull_requests: forge.reader }),
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
});

const api = async (method: string, path: string, body?: unknown): Promise<Response> =>
  fetch(`${base_url}${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const segment = encodeURIComponent;

/** The decision the scripted operator makes on each review, and what it does after. */
const DECISIONS: { readonly [review: string]: string } = { analysis_review: "accept", plan_review: "accept", brief_review: "accept",
  admission: "admit", assessment_review: "accept", integration_review: "accept" };

/** Decide every review awaiting the operator once; merge a cohort's PR once its assessment is accepted. */
async function operate(run_id: string, decided: Set<string>, admitted: string[]): Promise<void> {
  const units = (await db.selectFrom("authority.unit").select(["id", "parent_id", "declaration", "review_prompts", "collection_key"]).where("run_id", "=", run_id).execute())
    .map((unit) => ({ ...unit, collection_key: selectCollectionKey(unit) }));
  for (const unit of units) {
    for (const [review, awaiting] of Object.entries(unit.review_prompts)) {
      const key = `${unit.id}:${review}:${awaiting.target}`;
      if (decided.has(key)) continue;
      const decision = DECISIONS[review];
      if (!decision) throw new Error(`no decision for review ${review}`);
      const response = await api("POST", `/api/runs/${segment(run_id)}/units/${segment(unit.id)}/reviews/${review}/decide`,
        { request_id: crypto.randomUUID(), decision, target: awaiting.target, payload: {} });
      if (response.status !== 201) throw new Error(`${review} on ${unit.id} refused: ${await response.text()}`);
      decided.add(key);
      if (review === "admission") { admitted.push(unit.collection_key ?? ""); timeline.set(`admit:${unit.collection_key}`, Date.now()); }
      if (review === "assessment_review") { forge.merge(`cohort-${unit.collection_key}`); timeline.set(`merge:${unit.collection_key}`, Date.now()); }
      if (review === "integration_review") forge.merge("integration");
    }
  }
}

test("D1: the development workflow runs to completion with two cohorts, b after a", async () => {
  const pinned = await api("POST", "/api/definitions", developmentWorkflow());
  if (pinned.status !== 201 && pinned.status !== 200) throw new Error(`pin refused: ${await pinned.text()}`);
  const { digest } = await pinned.json() as { readonly digest: string };
  const request_id = crypto.randomUUID();
  const launched = await api("POST", "/api/runs", { request_id, digest, input: {
    title: "Two cohorts", spec: "Build the thing in two parts.", admission: true, final_merge_policy: "require_merge",
    repositories: [{ key: "app", preparation: { repository_path: repository, expected_head: null },
      forge: { owner: "oakridge-e2e", name: "app", build_base: "develop", final_base: "main" } }] } });
  if (launched.status !== 201) throw new Error(`launch refused: ${await launched.text()}`);
  const run_id = launchRunId(request_id);

  const decided = new Set<string>();
  const admitted: string[] = [];
  const run = await eventually("the run to finish", async () => {
    await operate(run_id, decided, admitted);
    const row = await db.selectFrom("authority.unit").select("status").where("run_id", "=", run_id).where("id", "=", run_id).executeTakeFirstOrThrow();
    return row.status.kind === "done" ? row.status : null;
  }, 120_000);

  const units = (await db.selectFrom("authority.unit").select(["id", "parent_id", "declaration", "stage", "collection_key"]).where("run_id", "=", run_id).execute())
    .map((unit) => ({ ...unit, collection_key: selectCollectionKey(unit) }));
  const unitOf = (stage: string, member?: string) => units.find((unit) => unit.stage === stage && (member === undefined || unit.collection_key === member))?.id ?? "";
  const schemaOf = async (unit: string, artifact: string): Promise<string> =>
    (await (await api("GET", `/api/runs/${segment(run_id)}/units/${segment(unit)}/artifacts/${artifact}`)).json() as { readonly schema: string }).schema;
  const schemas = {
    analysis: await schemaOf(unitOf("analysis"), "analysis"), plan: await schemaOf(unitOf("planning"), "plan"),
    brief: await schemaOf(unitOf("brief", "a"), "brief"), build_result: await schemaOf(unitOf("cohort", "a"), "build_result"),
    assessment: await schemaOf(unitOf("cohort", "a"), "assessment"), pr: await schemaOf(unitOf("integration"), "pr"),
  };
  // A watch polls every second but publishes only a change: no two successive pr_state revisions agree.
  const pr_states = await db.selectFrom("authority.artifact_revision").select(["unit_id", "body"]).where("run_id", "=", run_id)
    .where("artifact", "=", "pr_state").orderBy("created_at").execute();
  const statesOf = (unit: string): readonly string[] => pr_states.filter((revision) => revision.unit_id === unit)
    .map((revision) => JSON.stringify(revision.body));
  const isChangesOnly = (states: readonly string[]): boolean => states.length > 0 && states.every((state, index) => index === 0 || state !== states[index - 1]);
  const outcome = (run as { readonly outcome: { readonly cohorts: readonly { readonly cohort_id: string }[];
    readonly integrations: readonly { readonly repository_key: string; readonly pr_url: string; readonly is_merged: boolean }[] } }).outcome;
  expect({
    cohorts: outcome.cohorts.map((cohort) => cohort.cohort_id),
    integrations: outcome.integrations,
    admitted: [...admitted].sort(),
    b_built_after_a_merged: (timeline.get("build:b") ?? 0) >= (timeline.get("merge:a") ?? Infinity),
    schemas,
    pr_states_change: [unitOf("cohort", "a"), unitOf("cohort", "b"), unitOf("integration")].map((unit) => isChangesOnly(statesOf(unit))),
  }).toEqual({
    cohorts: ["a", "b"],
    integrations: [{ repository_key: "app", pr_url: pullUrl(3), is_merged: true }],
    admitted: ["a", "b"],
    b_built_after_a_merged: true,
    schemas: BODY_SCHEMAS,
    pr_states_change: [true, true, true],
  });
}, 150_000);

test("development body schemas and v1 PWA viewer component IDs remain available", () => {
  // The v1 registry resolves component_id; the data layer supplies the schema-to-component mapping.
  // Read the registry as text rather than importing across the PWA boundary.
  const registry = readFileSync(resolve(root, "kbbl/core/pwa/oakridge/artifactRegistry.tsx"), "utf8");
  const workflow = developmentWorkflow();
  const declared = Object.values(BODY_SCHEMAS).filter((name) => workflow.schemas?.[name] !== undefined);
  const registered = Object.entries(VIEWER_COMPONENTS).filter(([componentId, viewer]) =>
    registry.includes(`"${componentId}": { Viewer: ${viewer} }`));
  expect({ declared, registered }).toEqual({
    declared: Object.values(BODY_SCHEMAS),
    registered: Object.entries(VIEWER_COMPONENTS),
  });
});
