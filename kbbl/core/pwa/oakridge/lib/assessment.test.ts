import { describe, expect, test } from "vitest";
import { makeAssessmentFixture } from "../__fixtures__/read-models";
import { selectBodyField, selectFieldItems, selectFieldText } from "../artifact-types";
import { selectAssessmentView } from "./assessment";

const report = makeAssessmentFixture({ findings: [
  { criterion: "Two.", status: "met", evidence: null, description: null },
  { criterion: "Four.", status: "partial", evidence: null, description: null },
  { criterion: "One.", status: "not_met", evidence: null, description: null },
  { criterion: "Extra.", status: "not_met", evidence: null, description: null },
] });

describe("assessment projection", () => {
  test("reads absent test evidence as null", () => {
    const { body } = makeAssessmentFixture({ test_evidence: null });
    expect(selectBodyField(body, "test_evidence")).toBeNull();
  });

  test("reads absent finding status and description as null", () => {
    const { body } = makeAssessmentFixture({ findings: [
      { criterion: "x", status: null, evidence: null, description: null },
    ] });
    const finding = selectFieldItems(body, "findings")[0];
    expect(finding && [selectFieldText(finding, "status"), selectFieldText(finding, "description")])
      .toEqual([null, null]);
  });

  test("puts unmet findings before partial findings", () => {
    const view = selectAssessmentView(report.body);
    expect(view.needs_attention.map((finding) => selectFieldText(finding, "criterion")))
      .toEqual(["One.", "Extra.", "Four."]);
  });

  test("keeps met findings apart", () => {
    const view = selectAssessmentView(report.body);
    expect(view.met.map((finding) => selectFieldText(finding, "criterion"))).toEqual(["Two."]);
  });

  test("tallies every explicit finding without inventing an unassessed brief criterion", () => {
    expect(selectAssessmentView(report.body).status_counts).toEqual([
      { status: "not_met", count: 2 }, { status: "partial", count: 1 }, { status: "met", count: 1 },
    ]);
  });

  test("tallies statuses with the worst first and omits empty counts", () => {
    const { body } = makeAssessmentFixture({ findings: [
      { criterion: "One.", status: "not_met", evidence: null, description: null },
      { criterion: "Two.", status: "met", evidence: null, description: null },
      { criterion: "Three.", status: "met", evidence: null, description: null },
      { criterion: "Four.", status: "met", evidence: null, description: null },
    ] });
    expect(selectAssessmentView(body).status_counts).toEqual([
      { status: "not_met", count: 1 }, { status: "met", count: 3 },
    ]);
  });

  test("lists findings without a brief lookup", () => {
    const { body } = makeAssessmentFixture({ findings: [
      { criterion: "Alone.", status: "partial", evidence: null, description: null },
    ] });
    expect(selectAssessmentView(body).needs_attention.map((finding) => selectFieldText(finding, "criterion")))
      .toEqual(["Alone."]);
  });
});
