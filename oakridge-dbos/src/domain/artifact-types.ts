export interface ArtifactCapabilities {
  readonly reviewable: boolean;
  readonly commentable: boolean;
  readonly atom_editable: boolean;
  /**
   * Structured claim/reality review items. Retired, and false on every type:
   * one type ever declared it, the gate flag that was supposed to act on them
   * was never enforced, and artifact threads cover commenting on all six
   * commentable types. The capability itself stays so the operator surface
   * self-disables from the same flag it always read, with no component change.
   */
  readonly review_items: boolean;
}

export interface ArtifactReviewDescriptor {
  readonly viewer: string;
  readonly layout: "document" | "dag" | "report";
  readonly sections: readonly string[];
  readonly action_labels: Readonly<Record<string, string>>;
  readonly action_consequences: Readonly<Record<string, string>>;
}

export interface ArtifactTypeDefinition {
  readonly id: string;
  readonly component_id: string;
  readonly capabilities: ArtifactCapabilities;
  readonly anchor_schema: readonly string[] | null;
  readonly review: ArtifactReviewDescriptor | null;
}

interface ActionPresentation {
  readonly labels: Readonly<Record<string, string>>;
  readonly consequences: Readonly<Record<string, string>>;
}

const reviewActions: Readonly<Record<string, ActionPresentation>> = {
  "dev.spec_analysis": { labels: { accept_analysis: "Accept analysis", revise_analysis: "Revise analysis" },
    consequences: { accept_analysis: "Analysis accepted. Planning can begin.", revise_analysis: "Feedback sent to the analyst for revision." } },
  "dev.plan": { labels: { accept_plan: "Accept plan", revise_plan: "Revise plan" },
    consequences: { accept_plan: "Plan accepted. Brief writing can begin.", revise_plan: "Feedback sent to the planner for revision." } },
  "dev.build_brief": { labels: { accept_briefs: "Accept briefs", revise_briefs: "Revise briefs" },
    consequences: { accept_briefs: "Brief collection accepted. Implementation can begin.", revise_briefs: "The complete brief collection will be revised." } },
  "dev.build_result": { labels: { accept_build: "Accept build", request_build_changes: "Request build changes" },
    consequences: { accept_build: "Build accepted. Assessment can begin.", request_build_changes: "Feedback sent to the builder for revision." } },
  "dev.assessment": { labels: { accept_assessment: "Accept assessment", discuss_assessment: "Discuss assessment", request_implementation_changes: "Request implementation changes" },
    consequences: { accept_assessment: "Assessment accepted. The cohort awaits merge.", discuss_assessment: "Feedback sent to the assessor for discussion.", request_implementation_changes: "Feedback sent to the builder for implementation changes." } },
  "dev.pr_summary": { labels: { confirm_merged: "Confirm merged", closed_without_merge: "Close without merge" },
    consequences: { confirm_merged: "Merge confirmed. The cohort can continue.", closed_without_merge: "The pull request was closed without merge." } },
};

const artifactType = (id: string, component_id: string, capabilities: ArtifactCapabilities, anchor_schema: readonly string[] | null, layout: ArtifactReviewDescriptor["layout"], sections: readonly string[]): ArtifactTypeDefinition => ({
  id, component_id, capabilities, anchor_schema,
  review: capabilities.reviewable ? { viewer: component_id, layout, sections,
    action_labels: reviewActions[id]?.labels ?? {}, action_consequences: reviewActions[id]?.consequences ?? {} } : null,
});

// Retained presentation contract; edit capabilities stay off until ingress supports them.
export const DEV_FLOW_ARTIFACT_TYPES: readonly ArtifactTypeDefinition[] = [
  artifactType("dev.spec_analysis", "dev-spec-analysis-viewer", { reviewable: true, commentable: true, atom_editable: false, review_items: false }, null, "document", ["summary", "findings", "requirements", "risks"]),
  artifactType("dev.build_brief", "dev-build-brief-viewer", { reviewable: true, commentable: true, atom_editable: false, review_items: false }, ["/goal", "/files_in_scope", "/decisions_made", "/approaches_rejected", "/acceptance_criteria", "/next_action"], "document", ["goal", "files_in_scope", "decisions_made", "approaches_rejected", "acceptance_criteria", "next_action"]),
  artifactType("dev.plan", "dev-plan-viewer", { reviewable: true, commentable: true, atom_editable: false, review_items: false }, ["/cohorts"], "dag", ["summary", "cohorts", "scope", "acceptance_criteria", "risks"]),
  artifactType("dev.build_result", "dev-build-result-viewer", { reviewable: true, commentable: true, atom_editable: false, review_items: false }, ["/summary", "/changed_files", "/tests", "/known_issues"], "report", ["summary", "changed_files", "tests", "known_issues"]),
  artifactType("dev.assessment", "dev-assessment-viewer", { reviewable: true, commentable: true, atom_editable: false, review_items: false }, null, "report", ["verdict", "findings", "test_evidence", "recommended_next_actions"]),
  artifactType("dev.pr_summary", "dev-pr-summary-viewer", { reviewable: true, commentable: false, atom_editable: false, review_items: false }, null, "report", ["pr_url", "branch", "summary", "review_status"]),
  // Machine output, not a document: the refs a repository was provisioned with.
  // Nothing about it is for a person to approve or annotate — the operator
  // chose the branch names when they configured the epic — so it carries no
  // review capability and never reaches a review surface.
  artifactType("dev.repository_refs", "dev-repository-refs-viewer", { reviewable: false, commentable: false, atom_editable: false, review_items: false }, null, "report", ["repository_key", "repository_path", "integration_branch", "base_branch", "base_head_sha"]),
];

export const findArtifactType = (id: string): ArtifactTypeDefinition | null => DEV_FLOW_ARTIFACT_TYPES.find((definition) => definition.id === id) ?? null;
