/** Resource keys preserve the run prefix so one refresh reaches its children. */
export const queryKeys = {
  operator: ["operator"] as const,
  config: ["oakridge", "config"] as const,
  inbox: ["operator", "inbox"] as const,
  runs: ["operator", "runs"] as const,
  runList: (is_archived: boolean) => ["operator", "runs", is_archived] as const,
  definitions: ["operator", "definitions"] as const,
  definitionList: (is_archived: boolean) => ["operator", "definitions", is_archived] as const,
  projects: ["operator", "projects"] as const,
  run: (runId: string) => ["operator", runId] as const,
  definition: (runId: string) => ["operator", runId, "definition"] as const,
  scope: (runId: string, scopeId: string | null) => ["operator", runId, "scope", scopeId] as const,
  history: (runId: string, scopeId: string) => ["operator", runId, "scope", scopeId, "history"] as const,
};
