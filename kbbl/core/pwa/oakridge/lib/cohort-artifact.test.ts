import { describe, expect, test } from "vitest";

import { makeBuildBriefFixture, makeBuildResultFixture, makeUnitWithArtifact } from "../__fixtures__/read-models";
import { selectArtifactInUnits, selectRunArtifacts } from "./run-overview";

describe("cohort artifacts in the run sidebar", () => {
  const brief = makeBuildBriefFixture({ cohort_id: "cm-api", repository_key: "assay", title: "Assemble the API" });
  const result = makeBuildResultFixture();
  const cohort = { unit_id: "cohort/cm-api", collection_key: "cm-api" };
  const units = [
    makeUnitWithArtifact({ body: brief.body, artifact_key: "brief", schema: "brief_body", revision_id: "brief-new", unit: cohort }),
    makeUnitWithArtifact({ body: result.body, artifact_key: "build", schema: "build_body", revision_id: "result", unit: { ...cohort, unit_id: "cohort/cm-api/build" } }),
  ];

  test("exposes the current brief revision for the cohort", () => {
    const artifact = selectArtifactInUnits(units, "brief-new");
    expect(artifact && [artifact.unit_id, artifact.artifact.schema]).toEqual(["cohort/cm-api", "brief_body"]);
  });

  test("keeps a build result distinct under the same cohort", () => {
    const artifact = selectArtifactInUnits(units, "result");
    expect(artifact && [artifact.unit_id, artifact.artifact.schema]).toEqual(["cohort/cm-api/build", "build_body"]);
  });

  test("finds no artifact for an unpublished cohort", () => {
    expect(selectRunArtifacts(units).find((artifact) => artifact.unit_id === "cohort/cm-ui")).toBeUndefined();
  });
});
