import { describe, expect, test } from "vitest";
import { parseAssessment, selectCriterionCounts, selectCriterionReport, type AssessmentFinding, type CriterionCheck } from "./assessment";

const finding = (criterion: string | null, status: AssessmentFinding["status"]): AssessmentFinding => ({
  criterion,
  status,
  evidence: null,
  description: null,
});

const label = (check: CriterionCheck) => (check.kind === "brief" ? `#${check.number}` : check.finding.criterion);

describe("parseAssessment", () => {
  const body = {
    verdict: "fail",
    findings: [{ criterion: "It works.", status: "not_met", evidence: "It does not." }],
    test_evidence: { passed: 3, failed: 1 },
    recommended_next_actions: ["Fix it."],
  };

  test("accepts the registered artifact body", () => {
    expect(parseAssessment(body).ok).toBe(true);
  });

  test("reads absent test evidence as null", () => {
    const parsed = parseAssessment({ ...body, test_evidence: null });
    expect(parsed.ok && parsed.value.test_evidence).toBeNull();
  });

  test("names a finding status outside the contract", () => {
    const parsed = parseAssessment({ ...body, findings: [body.findings[0], { criterion: "x", status: "done" }] });
    expect(parsed.ok ? null : parsed.error.field).toBe("findings[1].status");
  });

  test("names a finding field that is not text", () => {
    const parsed = parseAssessment({ ...body, findings: [{ criterion: "x", status: "met", evidence: 42 }] });
    expect(parsed.ok ? null : parsed.error.field).toBe("findings[0].evidence");
  });

  test("reads an omitted status and description as null", () => {
    const parsed = parseAssessment({ ...body, findings: [{ criterion: "x" }] });
    expect(parsed.ok && [parsed.value.findings[0]?.status, parsed.value.findings[0]?.description]).toEqual([null, null]);
  });

  test("names the field of broken test evidence", () => {
    const parsed = parseAssessment({ ...body, test_evidence: { passed: "3" } });
    expect(parsed.ok ? null : parsed.error.field).toBe("test_evidence.passed");
  });

  test("rejects a verdict outside the contract", () => {
    expect(parseAssessment({ ...body, verdict: "maybe" }).ok).toBe(false);
  });
});

describe("selectCriterionReport", () => {
  const criteria = ["One.", "Two.", "Three.", "Four."];
  const report = selectCriterionReport(criteria, [
    finding("Two.", "met"),
    finding("Four.", "partial"),
    finding("One.", "not_met"),
    finding("Extra.", "not_met"),
  ]);

  test("puts not met before partial before unassessed, brief order within each", () => {
    expect(report.needs_attention.map(label)).toEqual(["#1", "Extra.", "#4", "#3"]);
  });

  test("keeps met criteria apart", () => {
    expect(report.met.map(label)).toEqual(["#2"]);
  });

  test("tallies a criterion no finding names as unassessed", () => {
    expect(report.tally).toEqual({ met: 1, partial: 1, not_met: 2, unassessed: 1 });
  });

  test("matches a criterion despite whitespace drift", () => {
    const drifted = selectCriterionReport(["Runs  the\nsuite."], [finding("Runs the suite.", "met")]);
    expect(drifted.met.map(label)).toEqual(["#1"]);
  });

  test("lists findings alone when there is no brief", () => {
    expect(selectCriterionReport(null, [finding("Alone.", "partial")]).needs_attention.map(label)).toEqual(["Alone."]);
  });
});

describe("selectCriterionCounts", () => {
  test("drops empty counts and leads with the worst", () => {
    expect(selectCriterionCounts({ met: 3, partial: 0, not_met: 1, unassessed: 0 })).toEqual([
      { status: "not_met", count: 1 },
      { status: "met", count: 3 },
    ]);
  });
});
