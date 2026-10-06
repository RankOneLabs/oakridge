import { useQuery } from "@tanstack/react-query";
import { fetchOperatorRuns } from "../client";
export function useRuns(enabled = true) {
  return useQuery({
    queryKey: ["operator", "runs"],
    queryFn: fetchOperatorRuns,
    refetchInterval: 10_000,
    enabled,
  });
}
