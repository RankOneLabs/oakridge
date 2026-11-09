import { expect, test } from "bun:test";
import { parseDrilldownKey } from "../src/http/grading-records";

const question = { question_id: "assessment_finding.evidence_support", question_version: "1" };
const key = (selector: object) => JSON.stringify({ logical_item_id: "l1", stage: "implementation", selector });

test("every selector a composite serves parses", () => {
  const served: readonly object[] = [{ kind: "items" }, { kind: "history" }, { kind: "disagreement", question },
    { kind: "answer", question, grader: { kind: "machine", evaluator_definition_id: "jev", backend_kind: "jev_direct", model: null }, answer: { state: "answered", value: "supports" } },
    { kind: "answer", question, grader: { kind: "human", evaluator_definition_id: "human", reviewer_id: "operator" }, answer: { state: "unclear" } },
    { kind: "status", question, evaluator_definition_id: null, status: { state: "not_ready", code: "build_result_unavailable" } },
    { kind: "status", question, evaluator_definition_id: "jev", status: { state: "failed", terminal_cause: null } }];
  for (const selector of served)
    expect({ selector, parsed: parseDrilldownKey(key(selector))?.selector as object | undefined }).toEqual({ selector, parsed: selector });
});

test("a selector missing a field its variant requires is refused, not read", () => {
  for (const selector of [{ kind: "disagreement" }, { kind: "answer", question }, { kind: "status", question, evaluator_definition_id: null },
    { kind: "answer", question, grader: { kind: "human", evaluator_definition_id: "human" }, answer: { state: "unclear" } },
    { kind: "status", question, evaluator_definition_id: null, status: { state: "not_ready" } }, { kind: "everything" }, { kind: "items", extra: 1 }])
    expect({ selector, parsed: parseDrilldownKey(key(selector)) }).toEqual({ selector, parsed: null });
  expect(parseDrilldownKey("nonsense")).toBeNull();
  expect(parseDrilldownKey(undefined)).toBeNull();
});
