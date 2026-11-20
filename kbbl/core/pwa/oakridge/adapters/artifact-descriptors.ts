import type { ArtifactTypeDescriptor } from "../artifact-types";
import { CURRENT_VIEWERS, selectArtifactComponent } from "../lib/artifact-version";
/** The development body schemas the run views show, and the viewer each opens in when its revision names no current version. */
export const SCHEMA_COMPONENTS: Readonly<Record<string, string>> = {
  ...CURRENT_VIEWERS, build_body: "dev-build-result-viewer", pr_body: "dev-pr-summary-viewer",
};
const SCHEMA_TYPES: Readonly<Record<string, string>> = {
  analysis_body: "dev.spec_analysis", spec_body: "dev.spec", plan_body: "dev.plan", brief_body: "dev.build_brief",
  build_body: "dev.build_result", assessment_body: "dev.assessment", pr_body: "dev.pr_summary",
};
export const artifactType = (schema: string, version?: string | null, is_adjudicated = false): ArtifactTypeDescriptor => schema === "workspace"
  ? { id: "workspace", component_id: "", capabilities: { reviewable: false, commentable: false, atom_editable: false, review_items: false }, anchor_schema: null }
  : { id: SCHEMA_TYPES[schema] ?? schema, component_id: selectArtifactComponent({ schema, version, is_adjudicated }) ?? SCHEMA_COMPONENTS[schema] ?? "",
    capabilities: { reviewable: true, commentable: true, atom_editable: true, review_items: true }, anchor_schema: null };
export const artifactTypes = (): ArtifactTypeDescriptor[] => [...new Map(Object.keys(SCHEMA_COMPONENTS).map((schema) => { const type = artifactType(schema); return [type.id, type]; })).values()];
