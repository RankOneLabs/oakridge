import type { RunArtifactRef } from "./run-overview";

/** Development workflow artifact groups shown in the run sidebar. */
export type RunArtifactFilter = "all" | "prep" | "briefs" | "pr_summaries" | "build_results" | "assessments";

export const RUN_ARTIFACT_FILTERS: readonly { readonly key: RunArtifactFilter; readonly label: string }[] = [
  { key: "all", label: "All artifacts" },
  { key: "prep", label: "Prep" },
  { key: "briefs", label: "Briefs" },
  { key: "pr_summaries", label: "PR summaries" },
  { key: "build_results", label: "Build results" },
  { key: "assessments", label: "Assessments" },
];

const ARTIFACT_GROUP: Readonly<Record<string, Exclude<RunArtifactFilter, "all">>> = {
  workspace: "prep",
  "dev.spec": "prep",
  "dev.plan": "prep",
  "dev.build_brief": "briefs",
  "dev.pr_summary": "pr_summaries",
  "dev.build_result": "build_results",
  "dev.assessment": "assessments",
};

export const selectFilteredRunArtifacts = (
  rows: readonly RunArtifactRef[], filter: RunArtifactFilter,
): readonly RunArtifactRef[] => filter === "all" ? rows : rows.filter((row) => ARTIFACT_GROUP[row.type_id] === filter);
