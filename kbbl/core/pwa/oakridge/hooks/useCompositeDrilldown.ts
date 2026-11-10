import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { readDrilldown, type DrilldownRequest } from "../client-grading";

export function useCompositeDrilldown(request: DrilldownRequest) {
  return useQuery({ queryKey: ["oakridge", "grading", "drilldown", request], queryFn: () => readDrilldown(request), retry: false,
    placeholderData: keepPreviousData, refetchInterval: 10_000 });
}
