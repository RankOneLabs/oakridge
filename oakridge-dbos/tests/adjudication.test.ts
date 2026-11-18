import { expect, test } from "bun:test";
import { composeBuilderFeedback, validateAdjudication, type Adjudication, type AdjudicationTarget } from "../src/domain/adjudication";

export const target: AdjudicationTarget = { id: "assessment:1", body: {
  head_sha: "head", verdict: "fail", test_evidence: { passed: 1, failed: 0 },
  item_assessments: [{ subject: { kind: "build_item", id: "B1" }, status: "partial", observation: "More work", evidence: [] }],
  additional_findings: [{ id: "F1", severity: "warning", observation: "Note", related_build_item_ids: [], evidence: [] }],
  next_actions: ["first", "second", "third", "operator"].map((text, index) => ({ id: `00000000-0000-4000-8000-00000000000${index}`,
    text, audience: index === 3 ? "operator" : "builder", source: { kind: "item_assessment", id: "B1" } })),
} };
export function validAdjudication(): Adjudication {
  const entries = target.body.next_actions.map((action, index) => ({ action_id: action.id, original_text: action.text,
    audience: action.audience, source: action.source, disposition: index === 1 ? "modified" as const : index === 2 ? "rejected" as const : "accepted" as const,
    ...(index === 1 ? { final_text: "replacement" } : {}) }));
  const added_actions = [{ action_id: "10000000-0000-4000-8000-000000000000", origin: "operator" as const, final_text: "added",
    audience: "builder" as const, source: { kind: "additional_finding" as const, id: "F1" } }];
  return { entries, added_actions, builder_feedback: composeBuilderFeedback(entries, added_actions) };
}
const validate = (payload: unknown, effect: Parameters<typeof validateAdjudication>[2] = "accept") => validateAdjudication(payload, target, effect);
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
interface RefusalCase { name: string; mutate: (payload: Adjudication) => unknown; id: string; effect?: Parameters<typeof validateAdjudication>[2] }
const refusalCases: RefusalCase[] = [
  { name: "payload on assessment changes", mutate: p => p, id: target.id, effect: "request_assessment_changes" },
  ...(["accept", "request_build_changes", "request_changes"] as const).map(effect => ({ name: `missing payload on ${effect}`, mutate: () => null, id: target.id, effect })),
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
  expect([validate(empty).ok, validate(empty, "request_build_changes").ok, validate(empty, "request_changes").ok]).toEqual([true, false, false]);
});
test("assessment change feedback retains legacy fields without adjudication", () => expect(validate({ feedback: "Reassess" }, "request_assessment_changes").ok).toBe(true));
