import { OPERATOR_CURRENT_ARTIFACT_VERSIONS } from "../operator-contracts/artifact-versions";
export interface ArtifactVersionIdentity { readonly artifact_schema_version?: string | null }
export interface CurrentVersionRegistration { readonly schema: string; readonly version: string; readonly component_id: string }
export const CURRENT_VIEWERS = {
  analysis_body: "dev-current-analysis-viewer", spec_body: "dev-current-spec-viewer",
  plan_body: "dev-current-plan-viewer", brief_body: "dev-current-brief-viewer",
} as const;
export const CURRENT_VERSIONS: readonly CurrentVersionRegistration[] = Object.entries(OPERATOR_CURRENT_ARTIFACT_VERSIONS)
  .filter(([, value]) => value.is_distinct).map(([schema, value]) => ({ schema, version: value.version, component_id: CURRENT_VIEWERS[schema as keyof typeof CURRENT_VIEWERS] }));
/** Unknown versions always retain the historical reader. No body shape detection. */
export const selectVersionedComponent = (schema: string, version: string | null | undefined, registrations = CURRENT_VERSIONS): string | null =>
  registrations.find((entry) => entry.schema === schema && entry.version === version)?.component_id ?? null;
export function artifactSchemaVersion(revision: unknown): string | null {
  if (!revision || typeof revision !== "object" || !("artifact_schema_version" in revision)) return null;
  return typeof revision.artifact_schema_version === "string" ? revision.artifact_schema_version : null;
}
