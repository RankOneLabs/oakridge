import { composeReworkFeedback, type Adjudication, type AddedActionEntry, type AdjudicationTarget } from "../src/domain/adjudication";

export const target: AdjudicationTarget = { id: "assessment:1", body: {
  head_sha: "head", verdict: "fail", test_evidence: { passed: 1, failed: 0 },
  item_assessments: [{ subject: { kind: "build_item", id: "B1" }, status: "partial", observation: "More work", evidence: [] }],
  additional_findings: [{ id: "F1", severity: "warning", observation: "Note", related_build_item_ids: [], evidence: [] }],
  next_actions: ["first", "second", "third", "operator", "operator modified", "operator rejected"].map((text, index) => ({ id: `00000000-0000-4000-8000-00000000000${index}`,
    text, audience: index >= 3 ? "operator" : "rework", source: { kind: "item_assessment", id: "B1" } })),
} };
export function validAdjudication(): Adjudication {
  const entries = target.body.next_actions.map((action, index) => ({ action_id: action.id, original_text: action.text,
    audience: action.audience, source: action.source, disposition: index % 3 === 1 ? "modified" as const : index % 3 === 2 ? "rejected" as const : "accepted" as const,
    ...(index % 3 === 1 ? { final_text: "replacement" } : {}) }));
  const added_actions: AddedActionEntry[] = [{ action_id: "10000000-0000-4000-8000-000000000000", origin: "operator" as const, final_text: "added",
    audience: "rework" as const, source: { kind: "additional_finding" as const, id: "F1" } }];
  added_actions.push({ ...added_actions[0], action_id: "20000000-0000-4000-8000-000000000000", audience: "operator" });
  return { entries, added_actions, rework_feedback: composeReworkFeedback(entries, added_actions) };
}

/** Keep operator dispositions while dropping every proposed or added rework action. */
export function dropRework(payload: Adjudication): Adjudication {
  return {
    entries: payload.entries.map(entry => entry.audience === "rework" ? { ...entry, disposition: "rejected" } : entry),
    added_actions: payload.added_actions.filter(entry => entry.audience === "operator"),
    rework_feedback: "",
  };
}
