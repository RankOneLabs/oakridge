import { useQuery } from "@tanstack/react-query";
import { fetchOperatorRunUnits } from "../client";
import { queryKeys } from "../queryKeys";

export function useRunUnits(runId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.units(runId),
    queryFn: () => fetchOperatorRunUnits(runId),
    enabled,
  });
}
