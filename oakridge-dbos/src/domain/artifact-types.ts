export interface ArtifactCapabilities {
  readonly reviewable: boolean;
  readonly commentable: boolean;
  readonly atom_editable: boolean;
  readonly review_items: boolean;
}

export interface ArtifactReviewDescriptor {
  readonly viewer: string;
  readonly layout: "document" | "dag" | "report";
  readonly sections: readonly string[];
  readonly action_labels: Readonly<Record<string, string>>;
}

export interface ArtifactTypeDefinition {
  readonly id: string;
  readonly component_id: string;
  readonly capabilities: ArtifactCapabilities;
  readonly anchor_schema: readonly string[] | null;
  readonly review: ArtifactReviewDescriptor | null;
}

const actions = { approve: "Approve", request_revision: "Request revision", confirm_merged: "Confirm merged", closed_without_merge: "Close without merge" } as const;
const artifactType = (id: string, component_id: string, capabilities: ArtifactCapabilities, anchor_schema: readonly string[] | null, layout: ArtifactReviewDescriptor["layout"], sections: readonly string[]): ArtifactTypeDefinition => ({
  id, component_id, capabilities, anchor_schema,
  review: capabilities.reviewable ? { viewer: component_id, layout, sections, action_labels: actions } : null,
});

// Exact presentation/capability contract from the retained Rust v2 dev-flow registry.
export const DEV_FLOW_ARTIFACT_TYPES: readonly ArtifactTypeDefinition[] = [
  artifactType("dev.spec_analysis", "dev-spec-analysis-viewer", { reviewable: true, commentable: true, atom_editable: false, review_items: true }, null, "document", ["summary", "findings", "requirements", "risks"]),
  artifactType("dev.build_brief", "dev-build-brief-viewer", { reviewable: true, commentable: true, atom_editable: true, review_items: false }, ["/goal", "/files_in_scope", "/decisions_made", "/approaches_rejected", "/acceptance_criteria", "/next_action"], "document", ["goal", "files_in_scope", "decisions_made", "approaches_rejected", "acceptance_criteria", "next_action"]),
  artifactType("dev.plan", "dev-plan-viewer", { reviewable: true, commentable: true, atom_editable: true, review_items: false }, ["/cohorts", "/dependency_order"], "dag", ["summary", "cohorts", "dependency_order", "scope", "acceptance_criteria", "risks"]),
  artifactType("dev.build_result", "dev-build-result-viewer", { reviewable: true, commentable: true, atom_editable: true, review_items: false }, ["/summary", "/changed_files", "/tests", "/known_issues"], "report", ["summary", "changed_files", "tests", "known_issues"]),
  artifactType("dev.assessment", "dev-assessment-viewer", { reviewable: true, commentable: true, atom_editable: false, review_items: false }, null, "report", ["verdict", "findings", "test_evidence", "recommended_next_actions"]),
  artifactType("dev.pr_summary", "dev-pr-summary-viewer", { reviewable: true, commentable: false, atom_editable: false, review_items: false }, null, "report", ["pr_url", "branch", "summary", "review_status"]),
];

export const findArtifactType = (id: string): ArtifactTypeDefinition | null => DEV_FLOW_ARTIFACT_TYPES.find((definition) => definition.id === id) ?? null;
