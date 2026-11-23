export function artifactSchemaVersion(revision: unknown): string | null {
  if (!revision || typeof revision !== "object" || !("artifact_schema_version" in revision)) return null;
  return typeof revision.artifact_schema_version === "string" ? revision.artifact_schema_version : null;
}
