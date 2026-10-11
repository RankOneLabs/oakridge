import { describe, expect, test } from "vitest";
import { makeAssessmentFixture } from "../__fixtures__/read-models";
import { selectCheckedField, selectFieldItems, selectFieldText } from "../artifact-types";
import { selectCheckedAssessmentView } from "./assessment";

const report = makeAssessmentFixture({ findings: [
  { criterion: "Two.", status: "met", evidence: null, description: null },
  { criterion: "Four.", status: "partial", evidence: null, description: null },
  { criterion: "One.", status: "not_met", evidence: null, description: null },
  { criterion: "Extra.", status: "not_met", evidence: null, description: null },
] });

describe("checked assessment projection", () => {
  test("reads absent test evidence as null", () => {
    const { body, schemas } = makeAssessmentFixture({ test_evidence: null });
    expect(selectCheckedField(body, schemas, "test_evidence")?.data).toEqual({ kind: "optional", value: null });
  });

  test("reads absent finding status and description as null", () => {
    const { body, schemas } = makeAssessmentFixture({ findings: [
      { criterion: "x", status: null, evidence: null, description: null },
    ] });
    const finding = selectFieldItems(body, schemas, "findings")[0];
    expect(finding && [selectFieldText(finding, schemas, "status"), selectFieldText(finding, schemas, "description")])
      .toEqual([null, null]);
  });

  test("puts unmet findings before partial findings", () => {
    const view = selectCheckedAssessmentView(report.body, report.schemas);
    expect(view.needs_attention.map((finding) => selectFieldText(finding, report.schemas, "criterion")))
      .toEqual(["One.", "Extra.", "Four."]);
  });

  test("keeps met findings apart", () => {
    const view = selectCheckedAssessmentView(report.body, report.schemas);
    expect(view.met.map((finding) => selectFieldText(finding, report.schemas, "criterion"))).toEqual(["Two."]);
  });

  test("tallies every explicit finding without inventing an unassessed brief criterion", () => {
    expect(selectCheckedAssessmentView(report.body, report.schemas).status_counts).toEqual([
      { status: "not_met", count: 2 }, { status: "partial", count: 1 }, { status: "met", count: 1 },
    ]);
  });

  test("tallies statuses with the worst first and omits empty counts", () => {
    const { body, schemas } = makeAssessmentFixture({ findings: [
      { criterion: "One.", status: "not_met", evidence: null, description: null },
      { criterion: "Two.", status: "met", evidence: null, description: null },
      { criterion: "Three.", status: "met", evidence: null, description: null },
      { criterion: "Four.", status: "met", evidence: null, description: null },
    ] });
    expect(selectCheckedAssessmentView(body, schemas).status_counts).toEqual([
      { status: "not_met", count: 1 }, { status: "met", count: 3 },
    ]);
  });

  test("lists findings without a brief lookup", () => {
    const { body, schemas } = makeAssessmentFixture({ findings: [
      { criterion: "Alone.", status: "partial", evidence: null, description: null },
    ] });
    expect(selectCheckedAssessmentView(body, schemas).needs_attention.map((finding) => selectFieldText(finding, schemas, "criterion")))
      .toEqual(["Alone."]);
  });
});
