import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { readRunTasks, type RunTasksRequest } from "../client-grading";

export function useRunTasks(request: RunTasksRequest) {
  return useQuery({ queryKey: ["oakridge", "grading", "tasks", request], queryFn: () => readRunTasks(request), retry: false,
    placeholderData: keepPreviousData, refetchInterval: 10_000 });
}
