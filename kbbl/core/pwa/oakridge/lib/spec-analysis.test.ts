import { describe, expect, test } from "vitest";
import { makeSpecAnalysisFixture } from "../__fixtures__/read-models";
import { selectFieldText } from "../artifact-types";
import { selectSpecAnalysisView } from "./spec-analysis";

const analysis = makeSpecAnalysisFixture({
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
});

describe("selectSpecAnalysisView", () => {
  test("pulls blocking findings and blocked requirements into blockers", () => {
    const view = selectSpecAnalysisView(analysis.body);
    expect(view.blockers.map((blocker) => selectFieldText(blocker.value, "id"))).toEqual(["f2", "r2"]);
  });

  test("lists remaining findings once, warnings before info", () => {
    const view = selectSpecAnalysisView(analysis.body);
    expect(view.findings.map((finding) => selectFieldText(finding, "id"))).toEqual(["f3", "f1"]);
  });

  test("lists remaining requirements once, ambiguous before implementable", () => {
    const view = selectSpecAnalysisView(analysis.body);
    expect(view.requirements.map((requirement) => selectFieldText(requirement, "id"))).toEqual(["r3", "r1"]);
  });

  test("tallies every item including blockers, most urgent first", () => {
    const view = selectSpecAnalysisView(analysis.body);
    expect(view.status_counts).toEqual([
      { status: "blocking", count: 1 }, { status: "warning", count: 1 }, { status: "info", count: 1 },
      { status: "blocked", count: 1 }, { status: "ambiguous", count: 1 }, { status: "implementable", count: 1 },
    ]);
  });

  test("omits statuses with no items from the tally", () => {
    const onlyInfo = makeSpecAnalysisFixture({ findings: [{ id: "f1", description: "Info note", severity: "info" }], requirements: [] });
    expect(selectSpecAnalysisView(onlyInfo.body).status_counts).toEqual([{ status: "info", count: 1 }]);
  });
});
