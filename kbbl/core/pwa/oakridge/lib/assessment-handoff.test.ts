import { describe, expect, it } from "vitest";
import type { Assessment } from "./assessment";
import { composeHandoffText, selectHandoffItems, withItemRemoved } from "./assessment-handoff";

const assessment: Assessment = {
  verdict: "pass_with_notes",
  findings: [{ criterion: "Ship it", status: "partial", evidence: "Some evidence", description: null }],
  test_evidence: null,
  recommended_next_actions: ["Fix the first issue", "Add coverage", "Document the result"],
};

describe("assessment handoff", () => {
  it("composes only included actions", () => {
    const items = selectHandoffItems(assessment).map((item) => item.index === 1 ? { ...item, is_included: false } : item);
    expect(composeHandoffText(items)).toBe("Recommended next actions for the builder:\n\n1. Fix the first issue\n2. Document the result");
  });

  it("uses edited text in the preview", () => {
    const items = selectHandoffItems(assessment).map((item) => item.index === 0 ? { ...item, text: "Fix the revised issue" } : item);
    expect(composeHandoffText(items)).toContain("1. Fix the revised issue");
  });

  it("removes one action and leaves the rest of the body identical", () => {
    const body = { ...assessment, extra_server_field: { retained: true } };
    expect(withItemRemoved(body, 1)).toEqual({ ...body, recommended_next_actions: ["Fix the first issue", "Document the result"] });
  });
});
