import { describe, expect, it } from "vitest";

import { selectFieldItems, selectFieldText, selectCheckedText } from "../artifact-types";
import {
  makeBuildBriefFixture, makeBuildResultFixture, makeOutputSlot, makeScopeView, makeScopeWithOutput,
} from "../__fixtures__/read-models";
import { selectRunArtifacts } from "./run-overview";

const brief = makeBuildBriefFixture({
  title: "End-to-end, browser, offline and packaging acceptance",
  repository_key: "assay",
  goal: "Close out the required cases in the browser and CLI.",
  files_in_scope: ["tests/test_review_acceptance.py"],
  depends_on: ["review-cli", "frontend-bundle"],
});

describe("build brief in generated scope outputs", () => {
  it("exposes the populated brief from its checked revision", () => {
    const artifact = selectRunArtifacts([makeScopeWithOutput({ body: brief.body, output_key: "brief" })])[0];
    expect(artifact && selectFieldText(artifact.revision.body, brief.schemas, "title"))
      .toBe("End-to-end, browser, offline and packaging acceptance");
    expect(artifact && selectFieldText(artifact.revision.body, brief.schemas, "repository_key")).toBe("assay");
    expect(artifact && selectFieldText(artifact.revision.body, brief.schemas, "goal")).toContain("Close out the required cases");
    expect(artifact && selectFieldItems(artifact.revision.body, brief.schemas, "files_in_scope").map(selectCheckedText))
      .toContain("tests/test_review_acceptance.py");
    expect(artifact && selectFieldItems(artifact.revision.body, brief.schemas, "depends_on").map(selectCheckedText))
      .toEqual(["review-cli", "frontend-bundle"]);
  });

  it("finds no brief for a scope with no output", () => {
    expect(selectRunArtifacts([makeScopeView({ outputs: [] })]).find((artifact) => artifact.output.output_key === "brief"))
      .toBeUndefined();
  });

  it("does not mistake a build result for a brief", () => {
    const result = makeBuildResultFixture();
    expect(selectRunArtifacts([makeScopeWithOutput({ body: result.body, output_key: "build_result" })]).find((artifact) => artifact.revision.body.schema === "brief_body"))
      .toBeUndefined();
  });

  it("finds no brief when the revision is absent", () => {
    const scope = makeScopeView({ outputs: [makeOutputSlot({ output_key: "brief", current_revision: null, current_revision_id: null })] });
    expect(selectRunArtifacts([scope]).find((artifact) => artifact.output.output_key === "brief")).toBeUndefined();
  });
});
