import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { readItemLineage } from "../client-grading";
import type { PageWindow } from "../grading-types";

export function useItemLineage(occurrence_id: string | null, page: PageWindow) {
  return useQuery({ queryKey: ["oakridge", "grading", "item-lineage", occurrence_id, page], enabled: occurrence_id !== null,
    queryFn: () => readItemLineage(occurrence_id ?? "", page), placeholderData: keepPreviousData });
}
