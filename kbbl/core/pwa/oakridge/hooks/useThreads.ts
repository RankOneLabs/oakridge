import { useQuery } from "@tanstack/react-query";
import { fetchOperatorThreads } from "../client";
import { queryKeys } from "../queryKeys";

export const useThreads = (runId: string, scopeId: string, revisionId: string, enabled = true) => useQuery({
  queryKey: queryKeys.threads(runId, scopeId, revisionId),
  queryFn: () => fetchOperatorThreads(runId, scopeId, revisionId),
  enabled,
});
