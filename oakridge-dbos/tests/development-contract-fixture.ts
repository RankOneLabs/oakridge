import type { AnalysisBody, SpecBody, PlanCohort, BriefBody, AssessmentBody } from "../../workflow-config/src/development-test-support";
import { composeBuilderFeedback, type Adjudication } from "../src/domain/adjudication";

/** Bodies mirror the canonical contract in workflow-config/development.yaml. */
export const APPROVED_ANALYSIS: AnalysisBody = {
  requirements: [{ id: "req-a", text: "Build the thing.", source_refs: ["Goal"], findings: [{
    id: "finding-a", severity: "info", observation: "Approved analysis for spec update.",
    evidence: [{ kind: "file", ref: "README.md", detail: "The existing implementation supports this change." }],
    expected_change_locations: [], resolution: { kind: "implementation_note", text: "Use the existing implementation pattern." },
  }] }],
};
export const REVISED_ANALYSIS: AnalysisBody = {
  requirements: APPROVED_ANALYSIS.requirements.map(requirement => ({ ...requirement,
    findings: requirement.findings.map(finding => ({ ...finding, observation: "Revised analysis for spec update." })),
  })),
};
export const APPROVED_SPEC: SpecBody = {
  objective: "Approved specification from analysis.",
  requirements: [{ id: "req-a", text: "Build the thing.", acceptance_conditions: ["Both contributions work together."],
    source_refs: ["Goal"], analysis_finding_ids: ["finding-a"] }],
  non_goals: [],
};
export const COHORTS: PlanCohort[] = [{ id: "a", depends_on: [] }, { id: "b", depends_on: ["a"] }].map(cohort => ({
  ...cohort, repository_key: "app", title: `Cohort ${cohort.id}`, scope: "part",
  allocations: [{ requirement_id: "req-a", contribution: `Contribution ${cohort.id} to the thing.` }],
  rationale: "Each contribution is independently reviewable.",
}));
export function developmentBrief(id: string): BriefBody {
  const cohort = COHORTS.find(cohort => cohort.id === id);
  if (!cohort) throw new Error(`Unknown development cohort ${id}`);
  return { cohort_id: id, repository_key: cohort.repository_key, depends_on: cohort.depends_on, files_in_scope: [],
    build_items: [{ id: "item-a", requirement_ids: ["req-a"], instructions: cohort.allocations[0].contribution, verification: ["tests"] }],
    technical_decisions: [{ id: "choice", build_item_ids: ["item-a"], decision: "Use the simple implementation.", rationale: "It meets the requirement." }],
  };
}
export const COHORT_ASSESSMENT: AssessmentBody = {
  head_sha: "abc123", verdict: "pass",
  item_assessments: [{ subject: { kind: "build_item", id: "item-a" }, status: "met", observation: "it works", evidence: [{ kind: "test", ref: "development-e2e" }] }],
  additional_findings: [], next_actions: [], test_evidence: { passed: 1, failed: 0 },
};
export const INTEGRATION_ASSESSMENT: AssessmentBody = {
  head_sha: "abc123", verdict: "pass",
  item_assessments: [{ subject: { kind: "requirement", id: "req-a" }, status: "met", observation: "Both cohort changes pass together.", evidence: [{ kind: "test", ref: "integration suite", detail: "Both cohort changes pass together on the integration branch." }] }],
  additional_findings: [], next_actions: [], test_evidence: { passed: 2, failed: 0 },
};
export const ACCEPT_ADJUDICATION = { entries: [], added_actions: [], builder_feedback: "" };
/** An operator-added builder action supports requesting changes even when the assessor proposed none. */
export const INTEGRATION_REPLACEMENT_ADJUDICATION: Adjudication = (() => {
  const added_actions: Adjudication["added_actions"] = [{ action_id: "00000000-0000-4000-8000-000000000001", origin: "operator",
    audience: "builder", source: { kind: "item_assessment", id: "req-a" }, final_text: "Open a new integration PR." }];
  return { entries: [], added_actions, builder_feedback: composeBuilderFeedback([], added_actions) };
})();
