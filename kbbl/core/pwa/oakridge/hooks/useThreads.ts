import { useQuery } from "@tanstack/react-query";
import { fetchOperatorThreads } from "../client";
import { queryKeys } from "../queryKeys";

export const useThreads = (runId: string, unitId: string, revisionId: string, enabled = true) => useQuery({
  queryKey: queryKeys.threads(runId, unitId, revisionId),
  queryFn: () => fetchOperatorThreads(runId, unitId, revisionId),
  enabled,
});
