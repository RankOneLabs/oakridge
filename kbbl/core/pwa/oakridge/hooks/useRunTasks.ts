import { readRunRequirementComposites } from "../client-requirements";
import { useOperatorUnits } from "./useOperatorUnits";
import { selectRunIdentityRollup } from "../lib/tasks";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { readRunTasks, type RunTasksRequest } from "../client-grading";

export function useRunTasks(request: RunTasksRequest) {
  const units = useOperatorUnits(request.run_id);
  const identity = selectRunIdentityRollup(units.data ?? []);
  const isRequirements = identity.label === "Requirements";
  const gradingRequest = isRequirements ? { run_id: request.run_id, nested: request.nested } : request;
  const query = useQuery({ queryKey: ["oakridge", "grading", "tasks", identity.label, gradingRequest],
    queryFn: () => isRequirements ? readRunRequirementComposites(request) : readRunTasks(request), retry: false,
    placeholderData: (data, previous) => previous?.queryKey[3] === identity.label ? keepPreviousData(data) : undefined, refetchInterval: 10_000 });
  return { ...query, identity };
}
