import { useQuery } from "@tanstack/react-query";
import { fetchRuns } from "../client";
export function useRuns(filter?: string, enabled = true) {
  return useQuery({
    queryKey: ["oakridge", "runs", filter ?? ""],
    queryFn: () => fetchRuns(filter),
    refetchInterval: 10_000,
    enabled,
  });
}
