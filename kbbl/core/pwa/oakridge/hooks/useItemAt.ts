import { useQuery } from "@tanstack/react-query";
import { readItemAt } from "../client-grading";
import type { ObservationItemAddress } from "../grading-contracts/grading/item-reads";

/** Resolves an exact revision and path to its captured item. It asks nothing about tasks or cohorts. */
export function useItemAt(run_id: string, selection: ObservationItemAddress) {
  return useQuery({ queryKey: ["oakridge", "grading", "item-at", run_id, selection.source_revision_id, selection.item_path],
    queryFn: () => readItemAt(run_id, selection), retry: false, refetchInterval: 10_000 });
}
