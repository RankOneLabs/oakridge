import { useQuery } from "@tanstack/react-query";
import { fetchOperatorRun } from "../client";

export function useRun(id: string, enabled = true) {
  return useQuery({
    queryKey: ["operator", "run", id],
    queryFn: () => fetchOperatorRun(id),
    refetchInterval: 10_000,
    enabled,
  });
}
