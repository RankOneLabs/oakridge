import { describe, expect, it } from "vitest";
import type { ArtifactId } from "../../lib/ids";
import type { RunArtifactRef } from "./run-overview";
import { selectFilteredRunArtifacts, type RunArtifactFilter } from "./artifact-filter";

const types = [
  "workspace", "dev.spec_analysis", "dev.spec", "dev.plan", "dev.build_brief",
  "dev.pr_summary", "dev.build_result", "dev.assessment", "custom.report",
];
const rows: readonly RunArtifactRef[] = types.map((type_id) => ({
  artifact_id: type_id as ArtifactId, type_id, version: 1,
  stage_name: "stage", label: null, created_at: null,
}));

describe("run artifact filter", () => {
  it.each([
    ["prep", types.slice(0, 4)],
    ["briefs", ["dev.build_brief"]],
    ["pr_summaries", ["dev.pr_summary"]],
    ["build_results", ["dev.build_result"]],
    ["assessments", ["dev.assessment"]],
  ] as const)("selects %s artifacts", (filter, expected) => {
    expect(selectFilteredRunArtifacts(rows, filter).map((row) => row.type_id)).toEqual(expected);
  });

  it("keeps unknown artifact types visible in All", () => {
    const filter: RunArtifactFilter = "all";
    expect(selectFilteredRunArtifacts(rows, filter)).toEqual(rows);
  });
});
