import { describe, expect, test } from "vitest";
import { isSpecAnalysis, selectSpecAnalysisView, type SpecAnalysis } from "./spec-analysis";

const analysis: SpecAnalysis = {
  summary: "The brief is mostly implementable.",
  source_spec_refs: ["Brief §2"],
  findings: [
    { id: "f1", description: "Info note", severity: "info" },
    { id: "f2", description: "Schema conflict", severity: "blocking" },
    { id: "f3", description: "Naming drift", severity: "warning" },
  ],
  requirements: [
    { id: "r1", description: "Add the column", status: "implementable" },
    { id: "r2", description: "Needs upstream API", status: "blocked" },
    { id: "r3", description: "Unclear retention", status: "ambiguous" },
  ],
  risks: [{ description: "Migration locks the table", mitigation: "Backfill in batches" }],
};

describe("isSpecAnalysis", () => {
  test("accepts the registered artifact body", () => {
    expect(isSpecAnalysis(analysis)).toBe(true);
  });

  test("accepts empty arrays", () => {
    expect(isSpecAnalysis({ ...analysis, findings: [], requirements: [], risks: [], source_spec_refs: [] })).toBe(true);
  });

  test("rejects a risk without a mitigation", () => {
    expect(isSpecAnalysis({ ...analysis, risks: [{ description: "No plan" }] })).toBe(false);
  });

  test("rejects a finding severity outside the contract", () => {
    expect(isSpecAnalysis({ ...analysis, findings: [{ id: "f1", description: "x", severity: "critical" }] })).toBe(false);
  });

  test("rejects a requirement status outside the contract", () => {
    expect(isSpecAnalysis({ ...analysis, requirements: [{ id: "r1", description: "x", status: "done" }] })).toBe(false);
  });

  test("rejects a missing source_spec_refs", () => {
    const { source_spec_refs: _, ...rest } = analysis;
    expect(isSpecAnalysis(rest)).toBe(false);
  });
});

describe("selectSpecAnalysisView", () => {
  const view = selectSpecAnalysisView(analysis);

  test("pulls blocking findings and blocked requirements into blockers", () => {
    expect(view.blockers.map((blocker) => blocker.kind === "finding" ? blocker.finding.id : blocker.requirement.id)).toEqual(["f2", "r2"]);
  });

  test("lists remaining findings once, warnings before info", () => {
    expect(view.findings.map((finding) => finding.id)).toEqual(["f3", "f1"]);
  });

  test("lists remaining requirements once, ambiguous before implementable", () => {
    expect(view.requirements.map((requirement) => requirement.id)).toEqual(["r3", "r1"]);
  });

  test("tallies every item including blockers, most urgent first", () => {
    expect(view.tally.status_counts).toEqual([
      { status: "blocking", count: 1 }, { status: "warning", count: 1 }, { status: "info", count: 1 },
      { status: "blocked", count: 1 }, { status: "ambiguous", count: 1 }, { status: "implementable", count: 1 },
    ]);
  });

  test("omits statuses with no items from the tally", () => {
    const onlyInfo = selectSpecAnalysisView({ ...analysis, findings: [analysis.findings[0]], requirements: [] });
    expect(onlyInfo.tally.status_counts).toEqual([{ status: "info", count: 1 }]);
  });
});
