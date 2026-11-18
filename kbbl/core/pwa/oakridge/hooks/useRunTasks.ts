import { useOperatorUnits } from "./useOperatorUnits";
import { selectRunIdentityRollup } from "../lib/tasks";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { readRunTasks, type RunTasksRequest } from "../client-grading";

export function useRunTasks(request: RunTasksRequest) {
  const units = useOperatorUnits(request.run_id);
  const identity = selectRunIdentityRollup(units.data ?? []);
  const query = useQuery({ queryKey: ["oakridge", "grading", "tasks", request], queryFn: () => readRunTasks(request), retry: false,
    placeholderData: keepPreviousData, refetchInterval: 10_000 });
  return { ...query, identity };
}
