import { expect, test } from "bun:test";
import { DEV_FLOW_ARTIFACT_TYPES, findArtifactType } from "../src/domain/artifact-types";

test("retained v2 artifact presentation registry exposes all dev-flow contracts", () => {
  expect(DEV_FLOW_ARTIFACT_TYPES.map((definition) => definition.id)).toEqual([
    "dev.spec_analysis", "dev.build_brief", "dev.plan", "dev.build_result", "dev.assessment", "dev.pr_summary", "dev.repository_refs",
  ]);
  expect(findArtifactType("dev.plan")).toEqual(expect.objectContaining({ component_id: "dev-plan-viewer", review: expect.objectContaining({ layout: "dag" }) }));
  expect(findArtifactType("dev.build_brief")?.anchor_schema).toContain("/acceptance_criteria");
});

/**
 * Provisioned refs are machine output. Giving them a review descriptor would
 * put a branch name the operator already chose into the review inbox, ahead of
 * the documents that actually need a decision.
 */
test("provisioned repository refs carry no review surface", () => {
  const refs = findArtifactType("dev.repository_refs");
  expect(refs?.review).toBeNull();
  expect(refs?.capabilities).toEqual({ reviewable: false, commentable: false, atom_editable: false, review_items: false });
});
