import { useMutation, useQueryClient } from "@tanstack/react-query";
import { retryStuckStage } from "../client";

export interface RetryStageTarget {
  stageInstanceId: string;
  unitId?: string;
}

export function useRetryStuck(runId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ stageInstanceId, unitId }: RetryStageTarget) => retryStuckStage(stageInstanceId, unitId),
    onSuccess: () => { void client.invalidateQueries({ queryKey: ["oakridge", "run", runId] }); },
  });
}
