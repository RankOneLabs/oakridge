import { describe, expect, it } from "vitest";

import { selectFieldItems, selectFieldText, selectBodyText } from "../artifact-types";
import {
  makeBuildBriefFixture, makeBuildResultFixture, makeArtifact, makeUnitView, makeUnitWithArtifact,
} from "../__fixtures__/read-models";
import { selectRunArtifacts } from "./run-overview";

const brief = makeBuildBriefFixture({
  title: "End-to-end, browser, offline and packaging acceptance",
  repository_key: "assay",
  goal: "Close out the required cases in the browser and CLI.",
  files_in_scope: ["tests/test_review_acceptance.py"],
  depends_on: ["review-cli", "frontend-bundle"],
});

describe("build brief among a unit's artifacts", () => {
  it("exposes the populated brief from its latest revision", () => {
    const artifact = selectRunArtifacts([makeUnitWithArtifact({ body: brief.body, artifact_key: "brief" })])[0];
    expect(artifact && selectFieldText(artifact.revision.body, "title"))
      .toBe("End-to-end, browser, offline and packaging acceptance");
    expect(artifact && selectFieldText(artifact.revision.body, "repository_key")).toBe("assay");
    expect(artifact && selectFieldText(artifact.revision.body, "goal")).toContain("Close out the required cases");
    expect(artifact && selectFieldItems(artifact.revision.body, "files_in_scope").map(selectBodyText))
      .toContain("tests/test_review_acceptance.py");
    expect(artifact && selectFieldItems(artifact.revision.body, "depends_on").map(selectBodyText))
      .toEqual(["review-cli", "frontend-bundle"]);
  });

  it("finds no brief for a unit with no artifact", () => {
    expect(selectRunArtifacts([makeUnitView({ artifacts: [] })]).find((artifact) => artifact.artifact.artifact_key === "brief"))
      .toBeUndefined();
  });

  it("does not mistake a build result for a brief", () => {
    const result = makeBuildResultFixture();
    expect(selectRunArtifacts([makeUnitWithArtifact({ body: result.body, artifact_key: "build", schema: "build_body" })]).find((artifact) => artifact.artifact.schema === "brief_body"))
      .toBeUndefined();
  });

  it("finds no brief when the revision is absent", () => {
    const unit = makeUnitView({ artifacts: [makeArtifact({ artifact_key: "brief", latest_revision: null, revision_count: 0 })] });
    expect(selectRunArtifacts([unit]).find((artifact) => artifact.artifact.artifact_key === "brief")).toBeUndefined();
  });
});
