import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { readTask, type WindowQuery } from "../client-grading";

/** Explicit navigation to one task inside the run. An id the run has not captured is an error here, and stays visible on the items naming it. */
export function useTask(run_id: string, task_id: string, nested: WindowQuery) {
  return useQuery({ queryKey: ["oakridge", "grading", "task", run_id, task_id, nested], queryFn: () => readTask(run_id, task_id, nested), retry: false,
    placeholderData: keepPreviousData, refetchInterval: 10_000 });
}
