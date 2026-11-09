import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { readRunUnresolved } from "../client-grading";
import type { ObservationPageRequest } from "../grading-contracts/grading/composite";

export function useRunUnresolvedReferences(run_id: string, page: ObservationPageRequest) {
  return useQuery({ queryKey: ["oakridge", "grading", "unresolved", run_id, page], queryFn: () => readRunUnresolved(run_id, page), retry: false,
    placeholderData: keepPreviousData, refetchInterval: 10_000 });
}
