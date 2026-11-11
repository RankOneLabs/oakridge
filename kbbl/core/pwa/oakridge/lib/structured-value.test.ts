import { expect, test } from "vitest";
import { humaniseKey, toStructuredNode } from "./structured-value";

test.each([["task_ids", "Task ids"], ["commitSha", "Commit sha"], ["HTTPStatus", "Http status"], ["already labelled", "Already labelled"], ["", ""]])("humanises %s", (key, label) => expect(humaniseKey(key)).toBe(label));

test.each([[null, "None"], [true, "true"], [false, "false"], [42, "42"], ["Frozen prose", "Frozen prose"]])("renders scalar %s as text", (value, text) => expect(toStructuredNode(value)).toEqual({ kind: "text", text }));

test("nested objects become labelled sections and arrays become lists", () => {
  expect(toStructuredNode({ task_ids: ["T1", "T2"], metadata: { commitSha: "abc123" } })).toEqual({ kind: "section", fields: [
    { label: "Task ids", node: { kind: "list", items: [{ kind: "text", text: "T1" }, { kind: "text", text: "T2" }] } },
    { label: "Metadata", node: { kind: "section", fields: [{ label: "Commit sha", node: { kind: "text", text: "abc123" } }] } },
  ] });
});

test("empty collections retain their structure", () => expect([toStructuredNode([]), toStructuredNode({})]).toEqual([{ kind: "list", items: [] }, { kind: "section", fields: [] }]));
