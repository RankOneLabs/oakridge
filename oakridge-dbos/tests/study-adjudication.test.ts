import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Workflow } from "../src/core-client/core-types";
import type { DefinitionId, RunId } from "../src/domain/primitives";
import { composeReworkFeedback, type Adjudication } from "../src/domain/adjudication";
import { browserWritePolicy } from "../src/http/browser-write-policy";
import { createHttpApp } from "../src/http/app";
import { readHistory, readRun } from "../src/storage/read-store";
import { selectArtifactDetail } from "../src/projections/artifact-view";
import { selectUnitHistory } from "../src/projections/history-view";
import { commitTestDefinition } from "./committed-fixture";
import { launch, openAuthority, submitter, type Authority } from "./authority-fixture";
import { dropRework, target, validAdjudication } from "./adjudication-fixture";

// Study's expansion review adjudicates an assessment whose subjects are study cases, and
// sends corrections to the expander's `expansion` artifact rather than a build result.
let authority: Authority;
let definition_id: DefinitionId;
let app: ReturnType<typeof createHttpApp>;
beforeAll(async () => {
  authority = await openAuthority();
  const study = JSON.parse(readFileSync(new URL("../../workflow-core/fixtures/bundles/study.json", import.meta.url), "utf8")) as Workflow;
  const expand = study.stages.expand;
  const review = expand.reviews?.expansion_review;
  if (!review) throw new Error("Missing study expansion_review");
  const prompt = "review-loop/editor.md";
  const source = { ...study, input: "text", run: { units: { unit: { stage: "expand" } }, outcome: {} }, stages: {
    expand: { ...expand, input: {}, let: {},
      // The real assessment schema; the expansion body is not under test, so it is plain text.
      artifacts: { assessment: { ...expand.artifacts.assessment, validate: [] }, expansion: { kind: expand.artifacts.expansion.kind, schema: "text" } },
      workers: { expander: { kind: "agent", prompts: { initial: prompt, revise: prompt }, inputs: {}, produces: ["expansion", "assessment"] } },
      reviews: { expansion_review: { ...review, prompt, inputs: {} } }, done_when: "approved(assessment)", outcome: {} },
  } };
  ({ definition_id } = await commitTestDefinition({ source: source as unknown as Workflow, prompt_edit: { path: prompt, content: "Review the expansion assessment." } }));
  app = createHttpApp({ db: authority.db, core: authority.core, wake: () => undefined, application_version: "test", access: { kind: "loopback_open" }, write_policy: browserWritePolicy([]) });
});
afterAll(async () => { await authority?.close(); });

interface Parked { readonly run_id: RunId; readonly unit_id: string; readonly assessment_id: string; readonly expansion_id: string; readonly payload: Adjudication }
/** An expansion and its assessment published, the expander’s turn ended, so expansion_review is open. */
async function parked(): Promise<Parked> {
  const launched = await launch(authority, { definition_id, request_id: crypto.randomUUID(), input: "test" });
  if (!launched.result.ok || launched.result.value.kind !== "committed") throw new Error(JSON.stringify(launched.result));
  const run_id = launched.run_id;
  const unit_id = `${run_id}/unit`;
  const attempt = await authority.db.selectFrom("authority.attempt").select("action_id").where("unit_id", "=", unit_id).executeTakeFirstOrThrow();
  const writer = { kind: "executor" as const, attempt: attempt.action_id };
  const body = { ...target.body, item_assessments: target.body.item_assessments.map(item => ({ ...item, subject: { kind: "case", id: "B1" } })),
    next_actions: target.body.next_actions.map(({ id, ...action }) => action) };
  for (const [artifact, published] of [["expansion", "Expanded cases"], ["assessment", body]] as const) {
    const result = await submitter(authority)({ run_id, event: { kind: "revision_published", unit: unit_id, artifact, body: published, by: attempt.action_id }, writer });
    if (!result.ok || result.value.kind !== "committed") throw new Error(JSON.stringify(result));
  }
  const ended = await submitter(authority)({ run_id, event: { kind: "worker_ended", action: attempt.action_id, result: { kind: "succeeded" } }, writer });
  if (!ended.ok || ended.value.kind !== "committed") throw new Error(JSON.stringify(ended));
  const revisionOf = (artifact: string) => authority.db.selectFrom("authority.artifact_revision").selectAll().where("unit_id", "=", unit_id).where("artifact", "=", artifact).executeTakeFirstOrThrow();
  const assessment = await revisionOf("assessment");
  const expansion = await revisionOf("expansion");
  const stored = assessment.body as typeof target.body;
  const valid = validAdjudication();
  const entries = valid.entries.map((entry, index) => ({ ...entry, action_id: stored.next_actions[index].id }));
  return { run_id, unit_id, assessment_id: assessment.id, expansion_id: expansion.id, payload: { ...valid, entries, rework_feedback: composeReworkFeedback(entries, valid.added_actions) } };
}
interface Decide { readonly decision: string; readonly payload: unknown; readonly expected_assessment_revision_id?: string }
async function decide(state: Parked, { decision, payload, expected_assessment_revision_id = decision === "request_assessment_changes" ? undefined : state.assessment_id }: Decide) {
  return app.request(`/api/runs/${state.run_id}/units/${encodeURIComponent(state.unit_id)}/reviews/expansion_review/decide`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request_id: crypto.randomUUID(),
      target: decision === "send_to_expander" ? state.expansion_id : state.assessment_id, expected_assessment_revision_id, decision, payload }),
  });
}
const recorded = (state: Parked) => authority.db.selectFrom("authority.review_decision").selectAll().where("unit_id", "=", state.unit_id).execute();

test("a study send-back records its adjudication against the assessment it reviewed", async () => {
  const state = await parked();
  const response = await decide(state, { decision: "send_to_expander", payload: state.payload });
  expect({ status: response.status, body: response.status > 299 ? await response.text() : null }).toEqual({ status: 201, body: null });
  const read = await readRun(authority.db, state.run_id);
  if (!read) throw new Error("missing run");
  expect(read.intents.filter(intent => intent.payload.action.worker === "expander").at(-1)?.payload.engine_inputs.feedback.map(entry => entry.payload))
    .toEqual([{ feedback: state.payload.rework_feedback }]);
  const detail = selectArtifactDetail(read, { unit_id: state.unit_id, artifact: "assessment" });
  const decision = detail?.decisions.at(-1);
  const page = await readHistory(authority.db, { run_id: state.run_id, unit_id: state.unit_id, after: null, limit: 100 });
  if (!page) throw new Error("missing history");
  const history = selectUnitHistory(state.unit_id as never, page, null).events.find(event => event.event.kind === "operator_decided");
  expect({ is_adjudicated: detail?.is_adjudicated, target: decision?.target_revision_id, assessment: decision?.assessment_revision_id, adjudication: decision?.adjudication,
    history: history?.adjudication, history_assessment: history?.assessment_revision_id })
    .toEqual({ is_adjudicated: true, target: state.expansion_id, assessment: state.assessment_id, adjudication: state.payload,
      history: state.payload, history_assessment: state.assessment_id });
});
test("a study send-back is refused once the assessment it reviewed has a successor", async () => {
  const state = await parked();
  const published = await submitter(authority)({ run_id: state.run_id, event: { kind: "revision_published", unit: state.unit_id, artifact: "assessment",
    predecessor: state.assessment_id, body: { ...(await authority.db.selectFrom("authority.artifact_revision").select("body").where("id", "=", state.assessment_id).executeTakeFirstOrThrow()).body as typeof target.body, head_sha: "unseen-head" } } });
  expect(published.ok && published.value.kind).toBe("committed");
  const response = await decide(state, { decision: "send_to_expander", payload: state.payload });
  expect({ status: response.status, decisions: (await recorded(state)).length, reason: (await response.text()).includes("reviewed assessment changed") })
    .toEqual({ status: 409, decisions: 0, reason: true });
});
for (const [decision, change] of [["send_to_expander", (p: Adjudication) => ({ ...p, rework_feedback: "forged" })], ["accept", (p: Adjudication) => ({ ...p, entries: p.entries.slice(1) })]] as const)
  test(`a study ${decision} with an invalid adjudication is refused`, async () => {
    const state = await parked();
    const response = await decide(state, { decision, payload: change(state.payload) });
    expect({ status: response.status, decisions: (await recorded(state)).length }).toEqual({ status: 409, decisions: 0 });
  });
test("a study accept with a valid adjudication approves the assessment", async () => {
  const state = await parked();
  expect((await decide(state, { decision: "accept", payload: dropRework(state.payload) })).status).toBe(201);
});

test("plain study assessment changes commit without an expected assessment revision", async () => {
  const state = await parked();
  const payload = { feedback: "Reassess" };
  expect((await decide(state, { decision: "request_assessment_changes", payload })).status).toBe(201);
  expect((await recorded(state)).at(-1)?.payload).toEqual(payload);
});

test("plain study assessment changes refuse an expected assessment revision", async () => {
  const state = await parked();
  const response = await decide(state, { decision: "request_assessment_changes", payload: { feedback: "Reassess" },
    expected_assessment_revision_id: state.assessment_id });
  expect([response.status, await response.text()]).toEqual([409, expect.stringContaining("plain decision takes no assessment revision")]);
});
