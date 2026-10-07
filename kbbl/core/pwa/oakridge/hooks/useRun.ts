import { queryKeys } from "../queryKeys";
import { useQuery } from "@tanstack/react-query";
import { fetchOperatorRun } from "../client";

export function useRun(id: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.run(id),
    queryFn: () => fetchOperatorRun(id),
    enabled,
  });
}
