import { useQuery } from "@tanstack/react-query";
import { readItemUnresolved } from "../client-grading";
import type { ObservationItemOccurrenceId } from "../grading-contracts/domain/identity";

export function useItemUnresolvedReferences(run_id: string, occurrence_id: ObservationItemOccurrenceId) {
  return useQuery({ queryKey: ["oakridge", "grading", "item-unresolved", run_id, occurrence_id],
    queryFn: () => readItemUnresolved(run_id, occurrence_id), retry: false, refetchInterval: 10_000 });
}
