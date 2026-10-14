import { useQuery } from "@tanstack/react-query";
import { fetchOperatorDefinitionDetail } from "../client";
import { queryKeys } from "../queryKeys";

export function usePinnedDefinition(bundleId: string | null) {
  return useQuery({
    queryKey: queryKeys.definitionDetail(bundleId),
    queryFn: () => fetchOperatorDefinitionDetail(bundleId ?? ""),
    enabled: bundleId !== null,
    staleTime: Infinity,
  });
}
