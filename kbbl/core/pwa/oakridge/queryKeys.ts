/** Resource keys preserve the run prefix so one refresh reaches its children. */
export const queryKeys = {
  operator: ["operator"] as const,
  config: ["oakridge", "config"] as const,
  inbox: ["operator", "inbox"] as const,
  runs: ["operator", "runs"] as const,
  runList: (is_archived: boolean) => ["operator", "runs", is_archived] as const,
  definitions: ["operator", "definitions"] as const,
  definitionList: (is_archived: boolean) => ["operator", "definitions", is_archived] as const,
  definitionDetail: (bundleId: string | null) => ["operator", "definitions", "detail", bundleId] as const,
  projects: ["operator", "projects"] as const,
  run: (runId: string) => ["operator", runId] as const,
  definition: (runId: string) => ["operator", runId, "definition"] as const,
  unit: (runId: string, unitId: string | null) => ["operator", runId, "unit", unitId] as const,
  history: (runId: string, unitId: string) => ["operator", runId, "unit", unitId, "history"] as const,
  threads: (runId: string, unitId: string, revisionId: string) => ["operator", runId, "unit", unitId, "revision", revisionId, "threads"] as const,
};
