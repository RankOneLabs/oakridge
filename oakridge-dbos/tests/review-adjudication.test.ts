import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "kysely";
import { readFileSync } from "node:fs";
import type { Workflow } from "../src/core-client/core-types";
import type { DefinitionId, RunId } from "../src/domain/primitives";
import { composeReworkFeedback, validateAdjudication, type Adjudication } from "../src/domain/adjudication";
const REQUEST_BUILD_CHANGES = { key: "request_build_changes", effect: "request_changes", adjudication: "feedback", fields: [] } as const;
import { browserWritePolicy } from "../src/http/browser-write-policy";
import { createHttpApp } from "../src/http/app";
import { commitEvent } from "../src/storage/commit";
import { readRun, readRunSummary, readHistory } from "../src/storage/read-store";
import { selectRunView } from "../src/projections/run-view";
import { selectRequirementRollup } from "../src/projections/requirement-rollup";
import { selectArtifactDetail } from "../src/projections/artifact-view";
import { selectUnitHistory } from "../src/projections/history-view";
import { commitTestDefinition } from "./committed-fixture";
import { launch, openAuthority, submitter, type Authority } from "./authority-fixture";
import { dropRework, target, validAdjudication } from "./adjudication-fixture";

let authority: Authority;
let definition_id: DefinitionId;
let app: ReturnType<typeof createHttpApp>;
beforeAll(async () => {
  authority = await openAuthority();
  // Reuse the exact production schemas and review declarations with a minimal stage harness.
  const development = JSON.parse(readFileSync(new URL("../../workflow-core/fixtures/bundles/development.json", import.meta.url), "utf8")) as Workflow;
  const cohort = development.stages.cohort;
  const integration = development.stages.integration;
  const initial = "review-loop/editor.md";
  if (!cohort.reviews || !integration.reviews) throw new Error("Missing production reviews");
  const cohortReview = cohort.reviews.assessment_review;
  const integrationReview = integration.reviews.integration_review;
  const source = { ...development, input: "text", run: { units: { unit: { stage: "cohort" }, integration: { stage: "integration" } }, outcome: {} }, stages: {
    // Retain spec's declaration to retain the production versioning epoch.
    analysis: development.stages.analysis,
    cohort: { ...cohort, input: {}, let: {}, artifacts: { assessment: { ...cohort.artifacts.assessment, validate: [] }, build_result: cohort.artifacts.build_result },
      workers: { builder: { kind: "agent", prompts: { initial, revise: initial }, inputs: {}, produces: ["assessment", "build_result"] } },
      reviews: { assessment_review: { ...cohortReview, prompt: initial, inputs: {}, decisions: cohortReview.decisions } }, done_when: "approved(assessment)", outcome: {} },
    integration: { ...integration, input: {}, let: {}, artifacts: { assessment: { ...integration.artifacts.assessment, validate: [] } },
      workers: { writer: { kind: "agent", prompts: { initial, revise: initial }, inputs: {}, produces: ["assessment"] } },
      reviews: { integration_review: { ...integrationReview, prompt: initial, inputs: {} } }, done_when: "approved(assessment)", outcome: {} },
  } };

  ({ definition_id } = await commitTestDefinition({ source: source as unknown as Workflow, prompt_edit: { path: initial, content: "Review the assessment." } }));
  app = createHttpApp({ db: authority.db, core: authority.core, wake: () => undefined, application_version: "test", access: { kind: "loopback_open" }, write_policy: browserWritePolicy([]) });
});
afterAll(async () => { await authority?.close(); });
interface Parked { readonly run_id: RunId; readonly unit_id: string; readonly revision_id: string; readonly build_revision_id: string | null; readonly payload: Adjudication }
async function parked(integration = false, noActions = false): Promise<Parked> {
  const launched = await launch(authority, { definition_id, request_id: crypto.randomUUID(), input: "test" });
  if (!launched.result.ok || launched.result.value.kind !== "committed") throw new Error(JSON.stringify(launched.result));
  const run_id = launched.run_id;
  const unit_id = `${run_id}/${integration ? "integration" : "unit"}`;
  const body = { ...target.body, next_actions: noActions ? [] : target.body.next_actions.map(({ id, ...action }) => action) };
  const attempt = await authority.db.selectFrom("authority.attempt").select("action_id").where("unit_id", "=", unit_id).executeTakeFirstOrThrow();
  if (!integration) {
    const built = await submitter(authority)({ run_id, event: { kind: "revision_published", unit: unit_id, artifact: "build_result", by: attempt.action_id,
      body: { head_sha: target.body.head_sha, summary: "Built", changed_files: [], tests: { passed: 1, failed: 0 }, known_issues: [] } }, writer: { kind: "executor", attempt: attempt.action_id } });
    if (!built.ok || built.value.kind !== "committed") throw new Error(JSON.stringify(built));
  }
  const published = await submitter(authority)({ run_id, event: { kind: "revision_published", unit: unit_id, artifact: "assessment", body, by: attempt.action_id }, writer: { kind: "executor", attempt: attempt.action_id } });
  if (!published.ok || published.value.kind !== "committed") throw new Error(JSON.stringify(published));
  const revision = await authority.db.selectFrom("authority.artifact_revision").selectAll().where("unit_id", "=", unit_id).where("artifact", "=", "assessment").executeTakeFirstOrThrow();
  const ended = await submitter(authority)({ run_id, event: { kind: "worker_ended", action: attempt.action_id, result: { kind: "succeeded" } }, writer: { kind: "executor", attempt: attempt.action_id } });
  if (!ended.ok || ended.value.kind !== "committed") throw new Error(JSON.stringify(ended));
  const stored = revision.body as typeof target.body;
  const valid = validAdjudication();
  const entries = noActions ? [] : valid.entries.map((entry, index) => ({ ...entry, action_id: stored.next_actions[index].id }));
  const build = await authority.db.selectFrom("authority.artifact_revision").select("id").where("unit_id", "=", unit_id).where("artifact", "=", "build_result").executeTakeFirst();
  return { run_id, unit_id, revision_id: revision.id, build_revision_id: build?.id ?? null, payload: { ...valid, entries, rework_feedback: composeReworkFeedback(entries, valid.added_actions) } };
}
async function decide(parked: Parked, payload: unknown, decision = "accept", integration = false, expected = decision === "request_assessment_changes" ? undefined : parked.revision_id) {
  return app.request(`/api/runs/${parked.run_id}/units/${encodeURIComponent(parked.unit_id)}/reviews/${integration ? "integration_review" : "assessment_review"}/decide`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request_id: crypto.randomUUID(), target: decision === "request_build_changes" ? parked.build_revision_id : parked.revision_id, expected_assessment_revision_id: expected, decision, payload }),
  });
}
const decisions = (parked: Parked) => authority.db.selectFrom("authority.review_decision").selectAll().where("unit_id", "=", parked.unit_id).execute();
test("accept atomically persists all dispositions, actor and typed artifact/history projections", async () => {
  const state = await parked();
  const payload = dropRework(state.payload);
  const response = await decide(state, payload);
  expect({ status: response.status, body: response.status > 299 ? await response.text() : null }).toEqual({ status: 201, body: null });
  expect((await decisions(state))[0].payload).toEqual(payload);
  const read = await readRun(authority.db, state.run_id);
  if (!read) throw new Error("missing run");
  const decision = selectArtifactDetail(read, { unit_id: state.unit_id, artifact: "assessment" })?.decisions[0];
  expect({ target: decision?.target_revision_id, adjudication: decision?.adjudication, actor: decision?.actor?.kind, time: decision?.created_at instanceof Date })
    .toEqual({ target: state.revision_id, adjudication: payload, actor: "operator", time: true });
  const page = await readHistory(authority.db, { run_id: state.run_id, unit_id: state.unit_id, after: null, limit: 100 });
  if (!page) throw new Error("missing history");
  expect(selectUnitHistory(state.unit_id as never, page, null).events.find(event => event.event.kind === "operator_decided")?.adjudication).toEqual(payload);
});
test("request_build_changes sends exactly the persisted rework_feedback to the worker", async () => {
  const state = await parked();
  expect((await decide(state, state.payload, "request_build_changes")).status).toBe(201);
  const read = await readRun(authority.db, state.run_id);
  const persisted = (await decisions(state))[0].payload as Adjudication;
  const feedback = read?.intents.filter(intent => intent.payload.action.worker === "builder").at(-1)?.payload.engine_inputs.feedback;
  expect(feedback?.map(entry => entry.payload)).toEqual([{ feedback: persisted.rework_feedback }]);
  if (!read) throw new Error("missing run");
  const decision = selectArtifactDetail(read, { unit_id: state.unit_id, artifact: "assessment" })?.decisions.at(-1);
  expect({ target: decision?.assessment_revision_id, payload: decision?.adjudication, effect_target: decision?.target_revision_id ?? null })
    .toEqual({ target: state.revision_id, payload: state.payload, effect_target: state.build_revision_id });
});
test("history includes assessed and added operator actions", async () => {
  const state = await parked();
  const control = await parked();
  const entries = control.payload.entries.map(entry => entry.audience === "operator"
    ? { ...entry, disposition: "rejected" as const, final_text: null } : entry);
  const added_actions = control.payload.added_actions.filter(entry => entry.audience === "rework");
  const controlPayload: Adjudication = { entries, added_actions, rework_feedback: control.payload.rework_feedback };

  expect((await decide(state, state.payload, "request_build_changes")).status).toBe(201);
  expect((await decide(control, controlPayload, "request_build_changes")).status).toBe(201);

  const [read, summary, controlRead] = await Promise.all([
    readRun(authority.db, state.run_id), readRunSummary(authority.db, state.run_id), readRun(authority.db, control.run_id),
  ]);
  if (!read || !summary || !controlRead) throw new Error("missing run");
  const view = selectRunView(read);
  const context = { unit_id: state.unit_id, assessment_revision_id: state.revision_id,
    review: "assessment_review", decision: "request_build_changes", created_at: expect.any(Date) };
  expect(view.operator_actions).toEqual([
    expect.objectContaining({ ...context, kind: "assessed", disposition: "accepted", original_text: "operator", final_text: null }),
    expect.objectContaining({ ...context, kind: "assessed", disposition: "modified", original_text: "operator modified", final_text: "replacement" }),
    expect.objectContaining({ ...context, kind: "assessed", disposition: "rejected", original_text: "operator rejected", final_text: null }),
    expect.objectContaining({ ...context, kind: "added", final_text: "added" }),
  ]);
  expect(selectRunView(summary)).not.toHaveProperty("operator_actions");
  expect(view.units.map(unit => [unit.unit_key, unit.asks]))
    .toEqual(selectRunView(controlRead).units.map(unit => [unit.unit_key, unit.asks]));
  expect(read.units.map(unit => Object.keys(unit.review_prompts)))
    .toEqual(controlRead.units.map(unit => Object.keys(unit.review_prompts)));

  const response = await app.request(`/api/runs/${state.run_id}`);
  expect(response.status).toBe(200);
  expect(await response.json()).toHaveProperty("operator_actions", JSON.parse(JSON.stringify(view.operator_actions)));
});
test("redirected adjudication refuses an unseen successor even when its actions still validate", async () => {
  const state = await parked(false, true);
  const original = await authority.db.selectFrom("authority.artifact_revision").select("body").where("id", "=", state.revision_id).executeTakeFirstOrThrow();
  const body = original.body as typeof target.body;
  const added_actions = state.payload.added_actions.map(entry => ({ ...entry, source: { kind: "item_assessment" as const, id: "B1" } }));
  const payload: Adjudication = { entries: [], added_actions, rework_feedback: composeReworkFeedback([], added_actions) };
  // The client has read state.revision_id. An operator publishes a successor before its POST reaches the lock.
  const published = await submitter(authority)({ run_id: state.run_id, event: { kind: "revision_published", unit: state.unit_id,
    artifact: "assessment", predecessor: state.revision_id, body: { ...body, head_sha: "unseen-head" } } });
  expect(published.ok && published.value.kind).toBe("committed");
  const successor = await authority.db.selectFrom("authority.artifact_revision").selectAll().where("unit_id", "=", state.unit_id)
    .where("artifact", "=", "assessment").orderBy("seq", "desc").executeTakeFirstOrThrow();
  expect(validateAdjudication({ payload, assessment: { id: successor.id, body: successor.body as typeof target.body }, decision: REQUEST_BUILD_CHANGES }).ok).toBe(true);
  const response = await decide(state, payload, "request_build_changes");
  expect({ status: response.status, decisions: (await decisions(state)).length }).toEqual({ status: 409, decisions: 0 });
  expect(await response.text()).toContain("reviewed assessment changed");
  // The same unchanged build target is usable only after explicitly reviewing the successor.
  expect((await decide({ ...state, revision_id: successor.id }, payload, "request_build_changes")).status).toBe(201);
});
test("redirected current adjudication requires an explicit expected assessment revision", async () => {
  const state = await parked();
  const response = await app.request(`/api/runs/${state.run_id}/units/${encodeURIComponent(state.unit_id)}/reviews/assessment_review/decide`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request_id: crypto.randomUUID(),
      target: state.build_revision_id, decision: "request_build_changes", payload: state.payload }),
  });
  expect({ status: response.status, decisions: (await decisions(state)).length }).toEqual({ status: 409, decisions: 0 });
});
test("assessment identity participates in decision replay identity", async () => {
  const state = await parked();
  const request = { run_id: state.run_id, ingress_id: crypto.randomUUID(), expected_assessment_revision_id: state.revision_id,
    writer: { kind: "operator" as const, subject: "test" }, event: { kind: "operator_decided" as const, unit: state.unit_id,
      review: "assessment_review", decision: "request_build_changes", target: state.build_revision_id as string, payload: state.payload } };
  const deps = { db: authority.db, core: authority.core, wake: () => undefined };
  const committed = await commitEvent(deps, request);
  const replayed = await commitEvent(deps, request);
  const changed = await commitEvent(deps, { ...request, expected_assessment_revision_id: "another-assessment" });
  expect([committed.ok && committed.value.kind, replayed.ok && replayed.value.kind, changed.ok && changed.value.kind])
    .toEqual(["committed", "replayed", "conflict"]);
});
interface Malformed { readonly name: string; readonly change: (payload: Adjudication) => unknown; readonly decision?: string }
const malformed: Malformed[] = [
  { name: "missing payload", change: () => null },
  { name: "missing entry", change: p => ({ ...p, entries: p.entries.slice(1) }) },
  { name: "unknown action", change: p => ({ ...p, entries: [{ ...p.entries[0], action_id: "unknown" }, ...p.entries.slice(1)] }) },
  { name: "added source", change: p => ({ ...p, added_actions: [{ ...p.added_actions[0], source: { kind: "item_assessment", id: "absent" } }] }) },
  { name: "modified without text", change: p => ({ ...p, entries: p.entries.map(entry => ({ ...entry, disposition: "modified", final_text: null })) }) },
  { name: "duplicate added id", change: p => ({ ...p, added_actions: [...p.added_actions, p.added_actions[0]] }) },
  { name: "empty builder feedback", decision: "request_build_changes", change: p => ({ ...p, rework_feedback: "" }) },
  { name: "extra key beside valid plain feedback", decision: "request_assessment_changes", change: () => ({ feedback: "Please reassess", stray: true }) },
  { name: "adjudication on assessment changes", decision: "request_assessment_changes", change: p => p },
];
for (const entry of malformed) test(`refused ${entry.name} leaves no decision and review parked`, async () => {
  const state = await parked();
  const response = await decide(state, entry.change(state.payload), entry.decision);
  const read = await readRun(authority.db, state.run_id);
  expect({ status: response.status, decisions: (await decisions(state)).length, unit: read?.units.find(unit => unit.id === state.unit_id)?.status.kind,
    rejected: (await authority.db.selectFrom("authority.ingress_receipt").select("result").where("run_id", "=", state.run_id).execute()).some(row => row.result.kind === "rejected") })
    .toEqual({ status: 409, decisions: 0, unit: "active", rejected: true });
});
for (const decision of ["accept", "request_changes"]) test(`integration ${decision} shares the same validation`, async () => {
  const state = await parked(true);
  expect((await decide(state, { ...state.payload, entries: [] }, decision, true)).status).toBe(409);
  expect((await decide(state, decision === "accept" ? dropRework(state.payload) : state.payload, decision, true)).status).toBe(201);
});
test("a fault after decision insert rolls the decision payload back", async () => {
  const state = await parked();
  const ingress_id = "faulted-adjudication";
  await sql`CREATE FUNCTION authority.fail_adjudication_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected fault'; END $$`.execute(authority.db);
  await sql`CREATE TRIGGER fail_adjudication_receipt BEFORE INSERT ON authority.ingress_receipt FOR EACH ROW WHEN (NEW.ingress_id = 'operator:faulted-adjudication') EXECUTE FUNCTION authority.fail_adjudication_receipt()`.execute(authority.db);
  try {
    const result = await commitEvent({ db: authority.db, core: authority.core, wake: () => undefined }, { run_id: state.run_id, ingress_id,
      writer: { kind: "operator", subject: "test" }, event: { kind: "operator_decided", unit: state.unit_id, review: "assessment_review", decision: "accept", target: state.revision_id, payload: dropRework(state.payload) } });
    expect({ faulted: !result.ok, decisions: (await decisions(state)).length }).toEqual({ faulted: true, decisions: 0 });
  } finally {
    await sql`DROP TRIGGER fail_adjudication_receipt ON authority.ingress_receipt`.execute(authority.db);
    await sql`DROP FUNCTION authority.fail_adjudication_receipt()`.execute(authority.db);
  }
});

test("computing the requirement rollup inserts no authority rows", async () => {
  const state = await parked(true);
  const rowCounts = async () => {
    const tables = ["authority.artifact_revision", "authority.review_decision", "authority.event", "authority.ingress_receipt"] as const;
    return Promise.all(tables.map(table => authority.db.selectFrom(table).select(({ fn }) => fn.countAll().as("count")).where("run_id", "=", state.run_id).executeTakeFirstOrThrow()));
  };
  const before = await rowCounts();
  const read = await readRun(authority.db, state.run_id);
  if (!read) throw new Error("missing read");
  selectRequirementRollup(read);
  expect(await rowCounts()).toEqual(before);
});

test("assessment changes retain the existing feedback payload without adjudication", async () => {
  const state = await parked();
  expect((await decide(state, { feedback: "Reassess the evidence." }, "request_assessment_changes")).status).toBe(201);
  expect((await decisions(state))[0].payload).toEqual({ feedback: "Reassess the evidence." });
});
test("legacy assessment decisions keep their original empty payload contract", async () => {
  const prompt = "review-loop/editor.md";
  const source = { workflow: "legacy_assessment", input: "text", run: { units: { unit: { stage: "cohort" } }, outcome: {} }, stages: {
    cohort: { input: {}, artifacts: { assessment: { kind: "assessment", schema: "text" } },
      workers: { writer: { kind: "agent", prompts: { initial: prompt }, inputs: {}, produces: ["assessment"] } },
      reviews: { assessment_review: { of: "assessment", by: "operator", prompt, decisions: { accept: { effect: "approve", label: "Accept" } } } }, done_when: "approved(assessment)", outcome: {} },
  } } as unknown as Workflow;
  const fixture = await commitTestDefinition({ source, prompt_edit: { path: prompt, content: "Review the legacy assessment." } });
  const launched = await launch(authority, { definition_id: fixture.definition_id, request_id: crypto.randomUUID(), input: "test" });
  const run_id = launched.run_id;
  const unit_id = `${run_id}/unit`;
  const published = await submitter(authority)({ run_id, event: { kind: "revision_published", unit: unit_id, artifact: "assessment", body: "Legacy assessment" } });
  if (!published.ok || published.value.kind !== "committed") throw new Error(JSON.stringify(published));
  const revision = await authority.db.selectFrom("authority.artifact_revision").select("id").where("unit_id", "=", unit_id).executeTakeFirstOrThrow();
  const response = await app.request(`/api/runs/${run_id}/units/${encodeURIComponent(unit_id)}/reviews/assessment_review/decide`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ request_id: crypto.randomUUID(), decision: "accept", target: revision.id, payload: {} }) });
  expect(response.status).toBe(201);
});

test("plain development assessment changes refuse an expected assessment revision", async () => {
  const state = await parked();
  const response = await decide(state, { feedback: "Reassess" }, "request_assessment_changes", false, state.revision_id);
  expect([response.status, await response.text()]).toEqual([409, expect.stringContaining("plain decision takes no assessment revision")]);
});

for (const disposition of ["accepted", "modified", "added"] as const) {
  test(`accept refuses a rework action that was ${disposition}`, async () => {
    const state = await parked();
    const dropped = dropRework(state.payload);
    const payload = disposition === "added" ? { ...dropped, added_actions: state.payload.added_actions }
      : { ...dropped, entries: dropped.entries.map((entry, index) =>
        index === 0 ? { ...entry, disposition, final_text: disposition === "modified" ? "Fix X" : entry.original_text } : entry) };
    const response = await decide(state, payload);
    expect([response.status, await response.text()]).toEqual([409, expect.stringContaining("accept cannot keep rework actions; drop them or send them")]);
  });
}

test("request_build_changes refuses when every rework action was dropped", async () => {
  const state = await parked();
  const response = await decide(state, dropRework(state.payload), "request_build_changes");
  expect([response.status, await response.text()]).toEqual([409, expect.stringContaining("feedback requires non-empty rework_feedback")]);
});
