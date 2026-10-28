import { describe, expect, test } from "vitest";
import { parseAssessment, selectCriterionCounts, selectCriterionReport, type AssessmentFinding, type CriterionCheck } from "./assessment";
import legacyAssessment from "./__fixtures__/legacy-assessment.json";
import linkedAssessment from "./__fixtures__/id-linked-assessment.json";
import emptyEvidenceAssessment from "./__fixtures__/empty-evidence-assessment.json";
import unresolvedAssessment from "./__fixtures__/unresolved-assessment.json";
import linkedBrief from "./__fixtures__/id-linked-brief.json";
import { readBuildBrief } from "./build-brief";

const finding = (criterion: string | null, status: AssessmentFinding["status"]): AssessmentFinding => ({
  criterion_id: null,
  criterion,
  status,
  evidence: { kind: "legacy", text: null },
  description: null,
});

const label = (check: CriterionCheck) => (check.kind === "brief" ? `#${check.number}` : check.finding.criterion);

describe("parseAssessment", () => {
  const body = legacyAssessment;

  test("reads legacy prose evidence and absent commit", () => {
    const parsed = parseAssessment(body);
    expect(parsed.ok && [parsed.value.head_sha, parsed.value.findings[0]?.criterion_id, parsed.value.findings[0]?.evidence]).toEqual([
      null, null, { kind: "legacy", text: "It does not." },
    ]);
  });

  test("reads linked criterion and typed references", () => {
    const parsed = parseAssessment(linkedAssessment);
    expect(parsed.ok && [parsed.value.head_sha, parsed.value.findings[0]?.criterion_id, parsed.value.findings[0]?.evidence]).toEqual([
      "abc123def456", "criterion-brief", { kind: "current", refs: [
        { kind: "file", ref: "kbbl/core/pwa/oakridge/lib/build-brief.ts:100-110", detail: "Parser accepts linked criteria." },
        { kind: "test", ref: "build-brief.test.ts::reads id-linked brief", detail: null },
        { kind: "output", ref: "bun run test:pwa", detail: "Passed" },
      ] },
    ]);
  });

  test("keeps an empty current evidence list observable", () => {
    const parsed = parseAssessment(emptyEvidenceAssessment);
    expect(parsed.ok && parsed.value.findings[0]?.evidence).toEqual({ kind: "current", refs: [] });
  });

  test("rejects mixed evidence generations at the later finding", () => {
    const parsed = parseAssessment({ ...body, findings: [...body.findings, linkedAssessment.findings[0]] });
    expect(parsed.ok ? null : parsed.error).toEqual({
      operation: "parse_assessment", field: "findings[1].evidence", detail: "mixed legacy and current evidence generations",
    });
  });

  test("an omitted evidence field does not set the list's generation", () => {
    const parsed = parseAssessment({ ...linkedAssessment, findings: [{ criterion: "Uncited." }, linkedAssessment.findings[0]] });
    expect(parsed.ok && parsed.value.findings.map((entry) => entry.evidence.kind)).toEqual(["legacy", "current"]);
  });

  test("rejects an unknown evidence kind at its entry", () => {
    const parsed = parseAssessment({ ...linkedAssessment, findings: [{ ...linkedAssessment.findings[0], evidence: [{ kind: "url", ref: "example" }] }] });
    expect(parsed.ok ? null : parsed.error.field).toBe("findings[0].evidence[0].kind");
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
    expect(drifted.met[0]?.match).toBe("normalized_text");
  });

  test("matches linked criteria by id across reorder and rewording", () => {
    const brief = readBuildBrief(linkedBrief);
    const parsed = parseAssessment(linkedAssessment);
    if (brief === null || !parsed.ok) throw new Error("fixture failed to parse");
    const first = parsed.value.findings[0];
    if (!first) throw new Error("fixture has no finding");
    const second = { ...first, criterion_id: brief.acceptance_criteria[1] && typeof brief.acceptance_criteria[1] !== "string" ? brief.acceptance_criteria[1].id : null, criterion: "Older wording.", status: "partial" as const };
    const reworded = brief.acceptance_criteria.map((criterion) => typeof criterion === "string" ? criterion : { ...criterion, text: `Reworded: ${criterion.text}` });
    const report = selectCriterionReport(reworded, [second, first]);
    expect([...report.needs_attention, ...report.met].map((check) => [label(check), check.match])).toEqual([["#2", "id"], ["#1", "id"]]);
  });

  test("leaves an unknown criterion id unresolved even when its text matches", () => {
    const brief = readBuildBrief(linkedBrief);
    const parsed = parseAssessment(unresolvedAssessment);
    if (brief === null || !parsed.ok) throw new Error("fixture failed to parse");
    const report = selectCriterionReport(brief.acceptance_criteria, parsed.value.findings);
    expect(report.needs_attention.map((check) => [label(check), check.match])).toEqual([
      ["The brief remains readable.", "unmatched"], ["#1", "unmatched"], ["#2", "unmatched"],
    ]);
  });

  test("lists findings alone when there is no brief", () => {
    expect(selectCriterionReport(null, [finding("Alone.", "partial")]).needs_attention.map((check) => [label(check), check.match])).toEqual([["Alone.", "unmatched"]]);
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
