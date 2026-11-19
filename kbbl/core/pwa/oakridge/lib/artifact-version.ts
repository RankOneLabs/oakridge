import { OPERATOR_CURRENT_ARTIFACT_VERSIONS } from "../operator-contracts/artifact-versions";
export interface ArtifactVersionIdentity { readonly artifact_schema_version?: string | null }
export interface CurrentVersionRegistration { readonly schema: string; readonly version: string; readonly component_id: string }
export const CURRENT_VIEWERS = {
  analysis_body: "dev-current-analysis-viewer", spec_body: "dev-current-spec-viewer",
  plan_body: "dev-current-plan-viewer", brief_body: "dev-current-brief-viewer", assessment_body: "dev-current-assessment-viewer",
} as const;
export const CURRENT_VERSIONS: readonly CurrentVersionRegistration[] = Object.entries(OPERATOR_CURRENT_ARTIFACT_VERSIONS)
  .filter(([, value]) => value.is_distinct).map(([schema, value]) => ({ schema, version: value.version, component_id: CURRENT_VIEWERS[schema as keyof typeof CURRENT_VIEWERS] }));
/** Unknown versions always retain the historical reader. No body shape detection. */
export interface VersionedSchemaRead { readonly schema: string; readonly version: string | null | undefined; readonly registrations?: readonly CurrentVersionRegistration[] }
export const selectVersionedComponent = ({ schema, version, registrations = CURRENT_VERSIONS }: VersionedSchemaRead): string | null =>
  registrations.find((entry) => entry.schema === schema && entry.version === version)?.component_id ?? null;
/** The viewer that composes an operator adjudication of an assessment's next actions. */
export const ADJUDICATION_VIEWER = "dev-current-assessment-viewer";
/** An artifact a review adjudicates opens in the adjudication viewer, whatever workflow pinned its schema; any other dispatches on its version. */
export interface ArtifactComponentRead extends VersionedSchemaRead { readonly is_adjudicated?: boolean }
export const selectArtifactComponent = (read: ArtifactComponentRead): string | null =>
  read.is_adjudicated ? ADJUDICATION_VIEWER : selectVersionedComponent(read);
export function artifactSchemaVersion(revision: unknown): string | null {
  if (!revision || typeof revision !== "object" || !("artifact_schema_version" in revision)) return null;
  return typeof revision.artifact_schema_version === "string" ? revision.artifact_schema_version : null;
}
