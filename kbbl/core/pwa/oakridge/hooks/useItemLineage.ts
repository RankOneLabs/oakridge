import { keepPreviousData, skipToken, useQuery } from "@tanstack/react-query";
import type { ObservationItemOccurrenceId } from "../grading-contracts/domain/identity";
import { readItemLineage } from "../client-grading";
import type { ObservationPageRequest } from "../grading-contracts/grading/composite";

export function useItemLineage(occurrence_id: ObservationItemOccurrenceId | null, page: ObservationPageRequest) {
  return useQuery({ queryKey: ["oakridge", "grading", "item-lineage", occurrence_id, page],
    queryFn: occurrence_id === null ? skipToken : () => readItemLineage(occurrence_id, page), placeholderData: keepPreviousData, refetchInterval: 10_000 });
}
