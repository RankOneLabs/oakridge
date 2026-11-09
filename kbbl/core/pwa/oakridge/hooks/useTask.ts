import { keepPreviousData, skipToken, useQuery } from "@tanstack/react-query";
import { readTask, type TaskRequest } from "../client-grading";

/**
 * Explicit navigation to one task inside the run. An id the run has not captured is an error here, and
 * stays visible on the items naming it. No request, no read.
 */
export function useTask(request: TaskRequest | null) {
  return useQuery({ queryKey: ["oakridge", "grading", "task", request], queryFn: request ? () => readTask(request) : skipToken, retry: false,
    placeholderData: keepPreviousData, refetchInterval: 10_000 });
}
