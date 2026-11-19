import { expect, test } from "bun:test";
import { composeBuilderFeedback, validateAdjudication, type AdjudicatedReviewDecision, type Adjudication } from "../src/domain/adjudication";

import { target, validAdjudication } from "./adjudication-fixture";

/** Decisions as development and study declare them on their adjudicated reviews. */
const adjudicated = (key: string, effect: AdjudicatedReviewDecision["effect"]): AdjudicatedReviewDecision => ({ key, effect, is_adjudication: true, fields: [] });
const DECLARED = {
  accept: adjudicated("accept", "approve"),
  request_build_changes: adjudicated("request_build_changes", "request_changes"),
  request_changes: adjudicated("request_changes", "request_changes"),
  send_to_expander: adjudicated("send_to_expander", "request_changes"),
  request_assessment_changes: { key: "request_assessment_changes", effect: "request_changes", is_adjudication: false, fields: ["feedback"] },
} as const satisfies Record<string, AdjudicatedReviewDecision>;
type DeclaredDecision = keyof typeof DECLARED;
const validate = (payload: unknown, decision: DeclaredDecision = "accept") => validateAdjudication({ payload, assessment: target, decision: DECLARED[decision] });
const actionId = target.body.next_actions[0].id;
test("accepts accepted, modified, rejected and added actions across audiences", () => expect(validate(validAdjudication()).ok).toBe(true));
test("feedback includes builder actions in order and omits rejected and operator actions", () => expect(validAdjudication().builder_feedback).toBe([
  `${actionId}: first`, `${target.body.next_actions[1].id}: replacement`, "10000000-0000-4000-8000-000000000000: added",
].join("\n")));
test("empty builder actions compose to an empty string", () => expect(composeBuilderFeedback([], [])).toBe(""));
test("wire entry order cannot change next_actions feedback order", () => {
  const payload = validAdjudication();
  expect(validate({ ...payload, entries: [...payload.entries].reverse() }).ok).toBe(true);
});
interface RefusalCase { name: string; mutate: (payload: Adjudication) => unknown; id: string; effect?: DeclaredDecision }
const refusalCases: RefusalCase[] = [
  { name: "payload on assessment changes", mutate: p => p, id: target.id, effect: "request_assessment_changes" },
  ...(["accept", "request_build_changes", "request_changes", "send_to_expander"] as const).map(effect => ({ name: `missing payload on ${effect}`, mutate: () => null, id: target.id, effect })),
  { name: "missing action", mutate: p => ({ ...p, entries: p.entries.slice(1) }), id: actionId },
  { name: "duplicate action", mutate: p => ({ ...p, entries: [...p.entries, p.entries[0]] }), id: actionId },
  { name: "unknown action", mutate: p => ({ ...p, entries: [{ ...p.entries[0], action_id: "unknown" }, ...p.entries.slice(1)] }), id: "unknown" },
  ...(["original_text", "audience", "source"] as const).map(field => ({ name: `mismatched ${field}`, id: actionId,
    mutate: (p: Adjudication) => ({ ...p, entries: [{ ...p.entries[0], [field]: field === "source" ? { kind: "additional_finding", id: "F1" } : field === "audience" ? "operator" : "different" }, ...p.entries.slice(1)] }) })),
  { name: "modified without final text", mutate: p => ({ ...p, entries: [{ ...p.entries[0], disposition: "modified" }, ...p.entries.slice(1)] }), id: actionId },
  { name: "modified with blank final text", mutate: p => ({ ...p, entries: [{ ...p.entries[0], disposition: "modified", final_text: "  " }, ...p.entries.slice(1)] }), id: actionId },
  { name: "accepted with changed final text", mutate: p => ({ ...p, entries: [{ ...p.entries[0], final_text: "different" }, ...p.entries.slice(1)] }), id: actionId },
  { name: "unresolvable added source", mutate: p => ({ ...p, added_actions: [{ ...p.added_actions[0], source: { kind: "item_assessment", id: "missing" } }] }), id: "10000000-0000-4000-8000-000000000000" },
  { name: "non UUID added id", mutate: p => ({ ...p, added_actions: [{ ...p.added_actions[0], action_id: "bad" }] }), id: "bad" },
  { name: "duplicate added id", mutate: p => ({ ...p, added_actions: [...p.added_actions, p.added_actions[0]] }), id: "10000000-0000-4000-8000-000000000000" },
  { name: "added id collides with assessor action", mutate: p => ({ ...p, added_actions: [{ ...p.added_actions[0], action_id: actionId }] }), id: actionId },
  { name: "blank added text", mutate: p => ({ ...p, added_actions: [{ ...p.added_actions[0], final_text: " " }] }), id: "10000000-0000-4000-8000-000000000000" },
  { name: "empty builder feedback", mutate: p => ({ ...p, builder_feedback: "" }), id: target.id, effect: "request_build_changes" },
  { name: "absent builder feedback", mutate: p => ({ ...p, builder_feedback: undefined }), id: target.id, effect: "request_build_changes" },
  { name: "forged builder feedback", mutate: p => ({ ...p, builder_feedback: "forged" }), id: target.id },
];
for (const entry of refusalCases) test(`refuses ${entry.name} with entity context`, () => {
  const result = validate(entry.mutate(validAdjudication()), entry.effect);
  expect(result.ok ? null : { operation: result.error.operation, id: result.error.entity_id }).toEqual({ operation: "validate_adjudication", id: entry.id });
});
test("all builder actions rejected permits accept but forbids requesting changes", () => {
  const payload = validAdjudication();
  const entries = payload.entries.map(entry => ({ ...entry, disposition: "rejected" as const }));
  const empty = { entries, added_actions: [], builder_feedback: "" };
  expect([validate(empty).ok, validate(empty, "request_build_changes").ok, validate(empty, "request_changes").ok, validate(empty, "send_to_expander").ok])
    .toEqual([true, false, false, false]);
});
test("assessment change feedback retains legacy fields without adjudication", () => expect(validate({ feedback: "Reassess" }, "request_assessment_changes").ok).toBe(true));

import { selectReviewedAssessmentId } from "../src/domain/adjudication";
test("redirected decisions resolve the assessment that existed when the event was recorded", () => {
  const revisions = [
    { id: "build:1", unit_id: "unit", artifact: "build_result", seq: 1, created_at: new Date(0) },
    { id: "assessment:1", unit_id: "unit", artifact: "assessment", seq: 1, created_at: new Date(1) },
    { id: "assessment:2", unit_id: "unit", artifact: "assessment", seq: 2, created_at: new Date(3) },
  ];
  const review = { assessment_artifact: "assessment", redirect_artifacts: ["build_result"], decisions: [DECLARED.accept, DECLARED.request_build_changes] };
  expect(selectReviewedAssessmentId({ decision: { review: "assessment_review", unit_id: "unit", target_revision_id: "build:1", created_at: new Date(2) }, review, revisions })).toBe("assessment:1");
});
test("a send-back resolves its assessment through whichever artifact the review declares it redirects to", () => {
  const revisions = [
    { id: "expansion:1", unit_id: "unit", artifact: "expansion", seq: 1 },
    { id: "assessment:1", unit_id: "unit", artifact: "assessment", seq: 1 },
  ];
  const review = { assessment_artifact: "assessment", redirect_artifacts: ["expansion"], decisions: [DECLARED.accept, DECLARED.send_to_expander] };
  const decision = { review: "expansion_review", unit_id: "unit", target_revision_id: "expansion:1" };
  expect([selectReviewedAssessmentId({ decision, review, revisions }), selectReviewedAssessmentId({ decision, review: null, revisions })]).toEqual(["assessment:1", null]);
});
