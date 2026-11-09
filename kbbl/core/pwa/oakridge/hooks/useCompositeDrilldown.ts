import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { readDrilldown, type WindowQuery } from "../client-grading";
import type { DrilldownKey, PageWindow } from "../grading-types";

export function useCompositeDrilldown(run_id: string, key: DrilldownKey, page: PageWindow, nested: WindowQuery) {
  return useQuery({ queryKey: ["oakridge", "grading", "drilldown", run_id, key, page, nested], queryFn: () => readDrilldown(run_id, key, page, nested), retry: false,
    placeholderData: keepPreviousData });
}
