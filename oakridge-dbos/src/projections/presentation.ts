/** Presentation choices for the output schemas shipped by workflow-config. */
export interface ArtifactCapabilities {
  readonly reviewable: boolean;
  readonly commentable: boolean;
  readonly atom_editable: boolean;
  readonly review_items: boolean;
}
export interface ArtifactPresentation {
  readonly artifact_type: string;
  readonly viewer: "document" | "report";
  readonly capabilities: ArtifactCapabilities;
}

const editable = { reviewable: true, commentable: true, atom_editable: true, review_items: true } as const;
const report = { reviewable: true, commentable: true, atom_editable: false, review_items: true } as const;
export const OUTPUT_PRESENTATION: Readonly<{ readonly [schema_key: string]: ArtifactPresentation }> = {
  analysis_body: { artifact_type: "analysis", viewer: "document", capabilities: editable },
  plan_body: { artifact_type: "plan", viewer: "document", capabilities: editable },
  brief_body: { artifact_type: "briefs", viewer: "document", capabilities: editable },
  build_body: { artifact_type: "build_result", viewer: "report", capabilities: report },
  pr_body: { artifact_type: "pr_summary", viewer: "report", capabilities: report },
  assessment_body: { artifact_type: "assessment", viewer: "report", capabilities: report },
};

export const STAGE_LABELS: Readonly<{ readonly [scope_key: string]: string }> = {
  development: "Development",
  repository_preparation: "Repository Preparation",
  spec_analysis: "Spec Analysis",
  planning: "Planning",
  brief_writing: "Brief Writing",
  implementation: "Implementation",
  final_integration: "Final Integration",
};

export type DecisionKind = "start" | "admission" | "work" | "review" | "assessment" | "merge";
/** Each state has an explicit operator decision presentation, even when no action is currently available. */
export const DECISION_KINDS: Readonly<{ readonly [scope_key: string]: Readonly<{ readonly [state_key: string]: DecisionKind }> }> = {
  development: { ready: "start", preparing: "work", analyzing: "work", planning: "work", briefing: "work", implementing: "work", integrating: "work" },
  repository_preparation: { ready: "start", working: "work" },
  spec_analysis: { ready: "start", waiting_admission: "admission", working: "work", review: "review" },
  planning: { ready: "start", waiting_admission: "admission", working: "work", review: "review" },
  brief_writing: { ready: "start", waiting_admission: "admission", working: "work", review: "review" },
  implementation: { ready: "start", waiting_admission: "admission", working: "work", review: "review", assessing: "assessment", assessment_review: "assessment", discussing: "assessment", awaiting_merge: "merge" },
  final_integration: { ready: "start", waiting_admission: "admission", working: "work", review: "merge" },
};

export function outputPresentation(schema_key: string): ArtifactPresentation | null { return OUTPUT_PRESENTATION[schema_key] ?? null; }
export function stageLabel(scope_key: string): string | null { return STAGE_LABELS[scope_key] ?? null; }
export function decisionKind(scope_key: string, state_key: string): DecisionKind | null { return DECISION_KINDS[scope_key]?.[state_key] ?? null; }
