import { queryKeys } from "../queryKeys";
import { useQuery } from "@tanstack/react-query";
import { fetchOperatorRuns } from "../client";
export function useRuns(enabled = true) {
  return useQuery({
    queryKey: queryKeys.runs,
    queryFn: fetchOperatorRuns,
    enabled,
  });
}
