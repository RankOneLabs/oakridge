import { expect, test } from "bun:test";
import { DEV_FLOW_ARTIFACT_TYPES, findArtifactType } from "../src/domain/artifact-types";
import { artifactRefFromRevision, V15_BINDING_SOURCES, V15_CHANGE_KINDS, V15_FACTS, V15_WORKER_KEYS } from "../src/domain/dev-flow-v15";
import type { ArtifactId } from "../src/domain/primitives";

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

test("assessment review actions have separate routes and consequences", () => {
  const review = findArtifactType("dev.assessment")?.review;
  expect(Object.keys(review?.action_labels ?? {})).toEqual([
    "accept_assessment", "discuss_assessment", "request_implementation_changes",
  ]);
  expect(new Set(Object.values(review?.action_labels ?? {})).size).toBe(3);
  expect(new Set(Object.values(review?.action_consequences ?? {})).size).toBe(3);
  expect(review?.action_consequences.discuss_assessment).toContain("assessor");
});

test("v15 artifact identity comes from the stored chain and revision", () => {
  expect(artifactRefFromRevision({ chain_id: "chain" as ArtifactId, revision: 3 })).toEqual({ id: "chain" as ArtifactId, version: 3 });
});

test("v15 checked names cover the serialized worker, fact, and binding vocabulary", () => {
  expect(V15_WORKER_KEYS).toEqual(["provision", "spec", "plan", "brief", "build", "assessment", "final_integration"]);
  for (const fact of ["provision_outputs_ready", "spec_outputs_ready", "plan_outputs_ready", "brief_outputs_ready", "final_outputs_ready", "final_execution_interrupted", "final_pr_merged_at_reviewed_head", "final_pr_closed_unmerged"] as const) expect(V15_FACTS).toContain(fact);
  expect(V15_BINDING_SOURCES).toContain("assessment.work.input.accepted_build");
  expect(V15_CHANGE_KINDS).toEqual(["set_cohort_state", "set_worker_state", "accept_outputs", "clear_acceptance", "fence_execution", "capture_accepted_build", "clear_accepted_build"]);
});
