import type { AnalysisBody, SpecBody, PlanCohort, BriefBody, AssessmentBody } from "../../workflow-config/src/development-test-support";

/** Bodies mirror the canonical contract in workflow-config/development.yaml. */
export const APPROVED_ANALYSIS: AnalysisBody = {
  requirements: [{ id: "req-a", text: "Build the thing.", source_refs: ["Goal"], findings: [{
    id: "finding-a", finding_impact: "info", finding_note: "Approved analysis for spec update.",
    supporting_citations: [{ kind: "file", citation_location: "README.md", detail: "The existing implementation supports this change." }],
    expected_change_locations: [], finding_resolution: { kind: "implementation_note", text: "Use the existing implementation pattern." },
  }] }],
};
export const REVISED_ANALYSIS: AnalysisBody = {
  requirements: APPROVED_ANALYSIS.requirements.map(requirement => ({ ...requirement,
    findings: requirement.findings.map(finding => ({ ...finding, finding_note: "Revised analysis for spec update." })),
  })),
};
export const APPROVED_SPEC: SpecBody = {
  objective: "Approved specification from analysis.",
  requirements: [{ id: "req-a", text: "Build the thing.", acceptance_conditions: ["Both contributions work together."],
    source_refs: ["Goal"], analysis_finding_ids: ["finding-a"] }],
  non_goals: [],
};
export const COHORTS: PlanCohort[] = [{ id: "a", prerequisite_cohorts: [] }, { id: "b", prerequisite_cohorts: ["a"] }].map(cohort => ({
  ...cohort, assigned_repository: "app", title: `Cohort ${cohort.id}`, change_scope: "part",
  allocations: [{ requirement_id: "req-a", contribution: `Contribution ${cohort.id} to the thing.` }],
  decision_reason: "Each contribution is independently reviewable.",
}));
export function developmentBrief(id: string): BriefBody {
  const cohort = COHORTS.find(cohort => cohort.id === id);
  if (!cohort) throw new Error(`Unknown development cohort ${id}`);
  return { cohort_id: id, assigned_repository: cohort.assigned_repository, prerequisite_cohorts: cohort.prerequisite_cohorts, files_in_scope: [],
    build_items: [{ id: "item-a", requirement_ids: ["req-a"], instructions: cohort.allocations[0].contribution, verification: ["tests"] }],
    technical_decisions: [{ id: "choice", build_item_ids: ["item-a"], decision: "Use the simple implementation.", decision_reason: "It meets the requirement." }],
  };
}
export const COHORT_ASSESSMENT: AssessmentBody = {
  head_sha: "abc123", verdict: "pass",
  item_assessments: [{ subject: { kind: "build_item", id: "item-a" }, status: "met", finding_note: "it works", supporting_citations: [{ kind: "test", citation_location: "development-e2e" }] }],
  additional_findings: [], proposals: [], verifications: [], test_evidence: { passed: 1, failing_tests: 0 },
};
export const INTEGRATION_ASSESSMENT: AssessmentBody = {
  head_sha: "abc123", verdict: "pass",
  item_assessments: [{ subject: { kind: "requirement", id: "req-a" }, status: "met", finding_note: "Both cohort changes pass together.", supporting_citations: [{ kind: "test", citation_location: "integration suite", detail: "Both cohort changes pass together on the integration branch." }] }],
  additional_findings: [], proposals: [], verifications: [], test_evidence: { passed: 2, failing_tests: 0 },
};
