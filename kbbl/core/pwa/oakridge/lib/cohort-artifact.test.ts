import { describe, expect, test } from "vitest";

import { makeBuildBriefFixture, makeBuildResultFixture, makeScopeWithOutput } from "../__fixtures__/read-models";
import { selectArtifactInScopes, selectRunArtifacts } from "./run-overview";

describe("checked cohort outputs in the run sidebar", () => {
  const brief = makeBuildBriefFixture({ cohort_id: "cm-api", repository_key: "assay", title: "Assemble the API" });
  const result = makeBuildResultFixture();
  const scopes = [
    makeScopeWithOutput({ body: brief.body, output_key: "briefs", collection_key: "cm-api", revision_id: "brief-new" }),
    makeScopeWithOutput({ body: result.body, output_key: "build_results", collection_key: "cm-api", revision_id: "result" }),
  ];

  test("exposes the current brief revision for the cohort", () => {
    const artifact = selectArtifactInScopes(scopes, "brief-new");
    expect(artifact && [artifact.output.collection_key, artifact.revision.body.schema]).toEqual(["cm-api", "brief_body"]);
  });

  test("keeps a build result distinct under the same cohort key", () => {
    const artifact = selectArtifactInScopes(scopes, "result");
    expect(artifact && [artifact.output.collection_key, artifact.revision.body.schema]).toEqual(["cm-api", "build_body"]);
  });

  test("finds no artifact for an unpublished cohort", () => {
    expect(selectRunArtifacts(scopes).find((artifact) => artifact.output.collection_key === "cm-ui")).toBeUndefined();
  });
});
