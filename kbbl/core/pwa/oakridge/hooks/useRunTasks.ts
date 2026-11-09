import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { readRunTasks, type WindowQuery } from "../client-grading";
import type { PageWindow } from "../grading-types";

export function useRunTasks(run_id: string, page: PageWindow, nested: WindowQuery) {
  return useQuery({ queryKey: ["oakridge", "grading", "tasks", run_id, page, nested], queryFn: () => readRunTasks(run_id, page, nested), retry: false,
    placeholderData: keepPreviousData, refetchInterval: 10_000 });
}
