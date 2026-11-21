import { describe, expect, it } from "vitest";
import { CURRENT_ASSESSMENT, sliceReportReviewUnit } from "../__fixtures__/current-assessments";
import { currentAdjudicationUnit } from "../__fixtures__/read-models";
import { artifactRevisionId } from "../adapters/core";
import { decisionAction, isDisplayedReviewDecision, reviewToGates } from "../adapters/gates";
import type { OperatorJsonValue } from "../operator-contracts/domain/primitives";
import type { OperatorUnitView } from "../operator-contracts/projections/unit-view";
import { ADJUDICATION_VIEWER, selectArtifactComponent } from "./artifact-version";
import { selectSubjectKindLabel } from "./current-assessment";
import { parseVersionedBody } from "./versioned-body";

/** Study pins its assessment in the v1 epoch with its own subject kinds, so no registered current version matches it. */
const STUDY_ASSESSMENT_VERSION = "artifact-schema/v1:57f201559fcc23f712187d5d695e6b26d79a583199cc4a394df88e6a36116fc9";
const studyAssessment = { ...CURRENT_ASSESSMENT, item_assessments: CURRENT_ASSESSMENT.item_assessments.map(item => ({ ...item, subject: { kind: "case", id: item.subject.id } })) };
/** Study's expansion review, as the authority projects it: the adjudicated assessment, an accept and a send-back on the expansion. */
function studyExpansionUnit(): OperatorUnitView {
  const unit = currentAdjudicationUnit();
  return { ...unit, stage: "expand",
    artifacts: unit.artifacts.map(artifact => ({ ...artifact, latest_revision: artifact.latest_revision && { ...artifact.latest_revision, artifact_schema_version: STUDY_ASSESSMENT_VERSION, body: JSON.parse(JSON.stringify(studyAssessment)) as OperatorJsonValue } })),
    decisions: unit.decisions.map(decision => {
      if (decision.submit.kind !== "review") return decision;
      const key = decision.submit.decision === "accept" ? "accept" : "send_to_expander";
      return { ...decision, key, submit: { ...decision.submit, review: "expansion_review", decision: key, target_revision_id: key === "accept" ? "assessment:1" : "expansion:1" } };
    }) };
}

describe("adjudication follows the review's declaration", () => {
  it("opens an adjudicated artifact in the adjudication viewer whatever its pinned version", () => {
    expect([selectArtifactComponent({ schema: "assessment_body", version: STUDY_ASSESSMENT_VERSION, is_adjudicated: true }),
      selectArtifactComponent({ schema: "assessment_body", version: STUDY_ASSESSMENT_VERSION })]).toEqual([ADJUDICATION_VIEWER, null]);
  });
  it("reads an adjudicated study assessment, whose subjects are study cases, as a current assessment", () => {
    const read = parseVersionedBody({ schema: "assessment_body", version: STUDY_ASSESSMENT_VERSION, is_adjudicated: true, body: studyAssessment });
    expect(read.ok && read.value?.kind).toBe("assessment");
  });
  it("requires adjudication on a gate whose decisions declare it, for a study expansion review", () => {
    const gates = reviewToGates(studyExpansionUnit());
    expect(gates.ok && gates.value.map(gate => [gate.gate_step, gate.requires_adjudication])).toEqual([["expansion_review", true]]);
  });
  it("labels subject kinds a workflow declares, keeping development's names", () => {
    expect(["build_item", "requirement", "case", "cohort_file"].map(selectSubjectKindLabel)).toEqual(["Build item", "Requirement", "Case", "Cohort file"]);
  });
});

it("projects the slice assessment separately and offers only plain gate actions", () => {
  const unit = sliceReportReviewUnit(currentAdjudicationUnit());
  const gates = reviewToGates(unit);
  const [plan, , , assessment] = unit.artifacts;
  expect(gates.ok && gates.value[0]).toMatchObject({
    gate_step: "slice_report_review", requires_adjudication: true,
    artifact_revision_id: artifactRevisionId(plan, "plan:1"),
    assessment_revision_id: artifactRevisionId(assessment, "slice_assessment:2"),
    resume_actions: ["change_design", "send_to_builder"],
  });
  expect(unit.decisions.map(decision => [decision.key, isDisplayedReviewDecision(decision)]))
    .toEqual([["change_design", true], ["expand", false], ["send_feedback_to_builder", false], ["send_to_builder", true]]);

  const development = currentAdjudicationUnit();
  const plain = { ...development.decisions[1], key: "request_assessment_changes", adjudication: null,
    submit: { kind: "review", review: "assessment_review", decision: "request_assessment_changes", effect: "request_changes", target_revision_id: "assessment:1" } } as const;
  expect(decisionAction(plain, [...development.decisions, plain])).toBe("request_assessment_changes");
});
