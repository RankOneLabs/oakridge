import { expect, test } from "vitest";
import type { ArtifactId } from "../../lib/ids";
import type { RunArtifactRef } from "./run-overview";
import { artifactKeyLabel, selectArtifactFilters, selectFilteredRunArtifacts } from "./artifact-filter";

const rows: RunArtifactRef[] = [
  { artifact_id: "one" as ArtifactId, type_id: "drafting.first_version", artifact_kind: "document", version: 1, stage_name: "drafting", label: null, created_at: null },
  { artifact_id: "two" as ArtifactId, type_id: "vetting.appraisal", artifact_kind: "assessment", version: 1, stage_name: "vetting", label: null, created_at: null },
];

test("filters use the artifact kinds present in the run", () => {
  expect(selectArtifactFilters(rows).map((filter) => filter.key)).toEqual(["all", "document", "assessment"]);
  expect(selectFilteredRunArtifacts(rows, "assessment")).toEqual([rows[1]]);
});

test("an artifact label uses the declaration key with spaces", () => {
  expect(artifactKeyLabel(rows[0].type_id)).toBe("first version");
});
