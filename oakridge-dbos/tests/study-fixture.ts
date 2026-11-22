import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import source from "../../workflow-core/fixtures/bundles/study.json";
import { decodeWorkflowSource } from "../src/core-client/source-types";
import type { KeyedExecutionRecovery } from "../src/domain/keyed-execution";
import { controlTokenMiddleware, operatorCredentialCheck } from "../src/http/control-auth";
import { installIngress } from "../src/http/ingress";
import { installReadModels } from "../src/http/read-models";
import { installMergeStatus } from "../src/http/merge-status";
import { decodePullRequestObserveInput } from "../src/operations/pull-request-observe";
import type { OperationRunner } from "../src/operations/runner";
import { reportWorker, type WorkerReport } from "../src/workflows/executor-ingress";
import { launch, submitter, type Authority } from "./authority-fixture";
import { commitTestDefinition } from "./committed-fixture";

const study = decodeWorkflowSource(source);
if (!study) throw new Error("Invalid generated study source");
export const studySource = study;

export const repository = { key: "oakridge", preparation: { repository_path: "/repos/oakridge" },
  forge: { owner: "acme", name: "oakridge", build_base: "epic", final_base: "main" } };
export const workspace = { repository_path: "/repos/oakridge", push_remote_owner: "acme", head: "head", base_branch: "epic" };
export const studyInput = { title: "Study", spec: "Study inputs", repositories: [repository], primary_repository_key: "oakridge",
  final_merge_policy: "require_merge", slice_case_limit: 2, slice_cap_cents: 100, approved_plan: null };
export const plan = {
  question: "Do these changes alter scores?",
  hypotheses: [{ id: "hypothesis", statement: "They do" }],
  cases: [{ id: "base", group: "slice", is_control: true }, { id: "two", group: "two", is_control: false },
    { id: "three", group: "three", is_control: false }],
  groups: [{ id: "slice", case_ids: ["base"] }, { id: "two", case_ids: ["two"] }, { id: "three", case_ids: ["three"] }],
  outcomes: [{ id: "scores", rule: "Record outcomes" }], decision_rule: [{ condition: "Scores observed", next_step: "Expand" }],
  models: [{ id: "model", route: "fake/model", per_attempt_cap_cents: 100, expected_cost_per_attempt: { cents: 10, basis: "assumption" } }],
  slice: { case_ids: ["base"], risk_reason: "Control", criteria: [{ id: "criterion", text: "Control scored" }] },
  slice_paid: { models: ["model"], repeats: 1, cap_cents: 100 },
  iteration_triggers: [{ id: "trigger", text: "Control does not replay" }], full_study_repeats: 2,
};
export const digestRecipe = { files: ["generator.py"], command: "sha256sum generator.py" };
export const pr = (key: string, number: number) => ({ pr_url: `https://github.com/acme/oakridge/pull/${number}`, branch: key, summary: key });
export const build = (key: string) => ({ cohort_id: key, title: key, head_sha: `${key}-head`, summary: key, changed_files: [] });
export const qualifications = (case_ids: readonly string[]) => case_ids.map((case_id) =>
  ({ case_id, reference_passes: true, omissions_isolated: true, controls_replayed: true, detail: "Qualification passed" }));
export const expansion = (key: string, case_ids: readonly string[]) => ({
  build: build(key), generator_digest: "digest", case_ids, qualifications: qualifications(case_ids),
});
export const sliceBuild = { ...expansion("slice", ["base"]), digest_recipe: digestRecipe };
export const spend = { cohort_file: "slice.json", attempt_count: 1, cap_cents: 100, generator_digest: "digest", case_ids: ["base"] };
export const paid = (key: string, populated = true) => ({
  run_key: key, generator_digest: "digest", qualifications: qualifications(["base"]),
  paid_results: populated ? [{ model_id: "model", case_id: "base", outcome: "scored", detail: "Evidence",
    spend_cents: 10, launch_command: "runner start", store_path: "/runs/result" }] : [],
  criteria_marks: [{ id: "criterion", status: "met", evidence: "Score" }],
  trigger_marks: [{ id: "trigger", status: "not_fired", evidence: "Replay" }], proposed_changes: [],
});
export const item = (kind: string, id: string) => ({ subject: { kind, id }, status: "met", observation: "Verified",
  evidence: [{ kind: "test", ref: id }] });
export const assessment = (key: string, items: readonly ReturnType<typeof item>[]) => ({
  head_sha: build(key).head_sha, item_assessments: items, additional_findings: [], proposals: [],
  verifications: [], test_evidence: { passed: 1, failed: 0 }, verdict: "pass",
});
export const sliceAssessment = (key: string) => ({ ...assessment("slice", [item("criterion", "criterion"), item("trigger", "trigger")]), run_key: key });
export const freeze = { build: build("freeze"), generator_digest: "digest", image_digest: "image",
  is_byte_identical: true, cohorts: [{ id: "full", file: "all.json", digest: "manifest", attempt_count: 6, cap_cents: 60,
    cost_basis: "measured", case_ids: ["base", "two", "three"], groups: ["slice", "two", "three"] }] };

export const studyOperations: OperationRunner = {
  async run({ operation, inputs }) {
    if (operation === "repository.prepare") return { kind: "succeeded", body: workspace };
    if (operation === "value.publish" && inputs && typeof inputs === "object" && "value" in inputs) return { kind: "succeeded", body: inputs.value };
    const decoded = decodePullRequestObserveInput(inputs);
    if (operation === "pull_request.observe" && decoded) {
      return { kind: "succeeded", body: { state: "merged", number: Number(decoded.query.pr_url.split("/").at(-1)),
        url: decoded.query.pr_url, head_sha: "head", merged_at: "2026-01-01T00:00:00Z" } };
    }
    throw new Error(`Unexpected operation ${operation}`);
  },
};

const operator = "operator-test";

export function attachExecutionHttp(authority: Pick<Authority, "db" | "core">, recovery: KeyedExecutionRecovery = "off") {
  const app = new Hono();
  const deps = { ...authority, wake: () => undefined, is_operator_request: operatorCredentialCheck(operator), keyed_execution_recovery: recovery };
  app.use("*", controlTokenMiddleware(operator));
  installIngress(app, deps);
  installReadModels(app, deps);
  installMergeStatus(app, { db: authority.db, operations: studyOperations });
  return app;
}

export async function openStudy(authority: Authority, options: { readonly source?: Parameters<typeof commitTestDefinition>[0]["source"];
  readonly input?: unknown; readonly recovery?: KeyedExecutionRecovery; readonly unit?: string; readonly prompt_edit?: { path: string; content: string } } = {}) {
  const { definition_id } = await commitTestDefinition({ source: options.source ?? studySource, prompt_edit: options.prompt_edit });
  const { run_id, result } = await launch(authority, { definition_id, request_id: crypto.randomUUID(), input: options.input ?? studyInput });
  expect(result).toMatchObject({ value: { kind: "committed" } });
  const send = submitter(authority);
  const unit = (name = options.unit ?? "design") => `${run_id}/${name}`;
  const app = attachExecutionHttp(authority, options.recovery);
  const request = async (method: string, route: string, body?: unknown, credential = operator, location = unit(), http = app) =>
    http.request(`/api/runs/${run_id}/units/${encodeURIComponent(location)}${route}`, {
      method, headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const action = (worker: string, location = unit()) => authority.db.selectFrom("authority.attempt").selectAll()
    .where("run_id", "=", run_id).where("unit_id", "=", location).where("worker", "=", worker)
    .orderBy("created_at", "desc").orderBy("seq", "desc").executeTakeFirstOrThrow();
  const revision = (artifact: string, location = unit()) => authority.db.selectFrom("authority.artifact_revision").selectAll()
    .where("run_id", "=", run_id).where("unit_id", "=", location).where("artifact", "=", artifact).orderBy("seq", "desc").executeTakeFirst();
  const report = async (worker: string, value: WorkerReport, location = unit()) => {
    const { action_id, seq } = await action(worker, location);
    const outcome = await reportWorker({ ...authority, wake: () => undefined }, { run_id, attempt: { action_id, seq }, report: value });
    expect(outcome).toMatchObject({ value: { kind: "committed" } });
  };
  const publish = async (worker: string, artifact: string, body: unknown, options: { location?: string; subject?: string } = {}) => {
    const location = options.location ?? unit();
    const by = (await action(worker, location)).action_id;
    const outcome = await send({ run_id, event: { kind: "revision_published", unit: location, artifact, body, by,
      subject: options.subject ?? null, predecessor: (await revision(artifact, location))?.id ?? null },
      writer: { kind: "session", session: worker, attempt: by } });
    expect(outcome).toMatchObject({ value: { kind: "committed" } });
    return (await revision(artifact, location))!;
  };
  const end = (worker: string, location = unit(), succeeded = true) => report(worker, { kind: "ended",
    result: succeeded ? { kind: "succeeded" } : { kind: "failed", code: "interrupted", detail: "Interrupted before publication" } }, location);
  const decide = async (review: string, decision: string, artifact: string, fields: object = { payload: {} }, location = unit()) => {
    return request("POST", `/reviews/${review}/decide`, {
      request_id: crypto.randomUUID(), decision, target: (await revision(artifact, location))?.id, ...fields,
    }, operator, location);
  };
  const code = async (worker: string, location: string) => {
    const pending = await action(worker, location);
    const { payload } = await authority.db.selectFrom("authority.effect_intent").select("payload")
      .where("action_id", "=", pending.action_id).where("seq", "=", pending.seq).executeTakeFirstOrThrow();
    if (payload.worker.kind !== "code") throw new Error("Expected a code intent");
    const result = await studyOperations.run({ operation: payload.worker.operation, inputs: payload.inputs });
    if (result.kind !== "succeeded") throw new Error("Stub code operation failed");
    const artifact = payload.worker.artifact;
    await report(worker, { kind: "published", unit: location, artifact, body: result.body, predecessor: (await revision(artifact, location))?.id ?? null }, location);
    await end(worker, location);
  };
  async function startRunner(worker = "slice_runner", location = unit()) {
    const secret = crypto.randomUUID();
    const { action_id, seq } = await action(worker, location);
    const intent = await authority.db.selectFrom("authority.effect_intent").selectAll()
      .where("action_id", "=", action_id).where("seq", "=", seq).executeTakeFirstOrThrow();
    const key = intent.payload.execution_key;
    if (!key) throw new Error("Runner intent has no execution key");
    await report(worker, { kind: "started", session_id: `session-${action_id}`, publication_secret_hash: createHash("sha256").update(secret).digest("hex") }, location);
    return { key, secret, intent };
  }
  const reviews = async (location = unit()) => (await authority.db.selectFrom("authority.unit").select("review_prompts")
    .where("run_id", "=", run_id).where("id", "=", location).executeTakeFirstOrThrow()).review_prompts;
  const retry = (worker: string, location = unit()) => request("POST", `/workers/${worker}/retry`, { request_id: crypto.randomUUID() }, operator, location);
  return { authority, run_id, app, unit, request, action, revision, publish, report, end, decide, code, startRunner, reviews, retry };
}
export type StudyRun = Awaited<ReturnType<typeof openStudy>>;

export async function prepareSlice(run: StudyRun) {
  await run.code("git", run.unit("prepare/oakridge"));
  await run.publish("designer", "plan", plan);
  await run.end("designer");
  expect((await run.decide("plan_review", "accept", "plan")).status).toBe(201);
  const built = await run.publish("slice_builder", "slice_build", sliceBuild);
  await run.publish("slice_builder", "pr", pr("slice", 1));
  await run.end("slice_builder");
  return run.publish("spend_requester", "spend_request", spend, { subject: built.id });
}
