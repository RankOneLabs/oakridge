import type { ArtifactTypeDescriptor } from "../artifact-types";
import { selectArtifactComponent } from "../lib/artifact-version";
export const SCHEMA_COMPONENTS: Readonly<Record<string, string>> = {
  analysis_body: "dev-spec-analysis-viewer", text: "dev-spec-viewer", spec_body: "dev-spec-viewer", plan_body: "dev-plan-viewer", tasks_body: "dev-tasks-viewer", brief_body: "dev-build-brief-viewer",
  build_body: "dev-build-result-viewer", assessment_body: "dev-assessment-viewer", pr_body: "dev-pr-summary-viewer",
};
const SCHEMA_TYPES: Readonly<Record<string, string>> = {
  analysis_body: "dev.spec_analysis", text: "dev.spec", spec_body: "dev.spec", plan_body: "dev.plan", tasks_body: "dev.tasks", brief_body: "dev.build_brief",
  build_body: "dev.build_result", assessment_body: "dev.assessment", pr_body: "dev.pr_summary",
};
export const artifactType = (schema: string, version?: string | null, is_adjudicated = false): ArtifactTypeDescriptor => schema === "workspace"
  ? { id: "workspace", component_id: "", capabilities: { reviewable: false, commentable: false, atom_editable: false, review_items: false }, anchor_schema: null }
  : { id: SCHEMA_TYPES[schema] ?? schema, component_id: selectArtifactComponent({ schema, version, is_adjudicated }) ?? SCHEMA_COMPONENTS[schema] ?? "",
    capabilities: { reviewable: true, commentable: true, atom_editable: true, review_items: true }, anchor_schema: null };
export const artifactTypes = (): ArtifactTypeDescriptor[] => [...new Map(Object.keys(SCHEMA_COMPONENTS).map((schema) => { const type = artifactType(schema); return [type.id, type]; })).values()];
