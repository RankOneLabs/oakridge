import type { RunArtifactRef } from "./run-overview";

export type RunArtifactFilter = string;

export const artifactKeyLabel = (typeId: string): string =>
  (typeId.split(".").at(-1) ?? typeId).replaceAll("_", " ");

export function selectArtifactFilters(rows: readonly RunArtifactRef[]): readonly { readonly key: string; readonly label: string }[] {
  const kinds = new Set(rows.flatMap(({ artifact_kind }) => artifact_kind ? [artifact_kind] : []));
  return [{ key: "all", label: "All artifacts" }, ...[...kinds].map((key) => ({ key, label: artifactKeyLabel(key) }))];
}

export const selectFilteredRunArtifacts = (rows: readonly RunArtifactRef[], filter: RunArtifactFilter): readonly RunArtifactRef[] =>
  filter === "all" ? rows : rows.filter((row) => row.artifact_kind === filter);
