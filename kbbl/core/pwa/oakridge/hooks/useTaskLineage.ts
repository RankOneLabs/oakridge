import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { readTaskLineage } from "../client-grading";
import type { ObservationPageRequest } from "../grading-contracts/grading/composite";

export function useTaskLineage(run_id: string, task_id: string, page: ObservationPageRequest) {
  return useQuery({ queryKey: ["oakridge", "grading", "task-lineage", run_id, task_id, page], queryFn: () => readTaskLineage(run_id, task_id, page), retry: false,
    placeholderData: keepPreviousData, refetchInterval: 10_000 });
}
