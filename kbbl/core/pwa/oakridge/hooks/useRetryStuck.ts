import { useMutation, useQueryClient } from "@tanstack/react-query";
import { retryRunUnit } from "../client";

/** Oakridge retries one run unit; there is no stage-level retry. */
export interface RetryUnitTarget {
  stageInstanceId: string;
  unitId: string;
}

export function useRetryStuck(runId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ stageInstanceId, unitId }: RetryUnitTarget) => retryRunUnit(stageInstanceId, unitId),
    onSuccess: () => { void client.invalidateQueries({ queryKey: ["oakridge", "run", runId] }); },
  });
}
