import { useMutation, useQueryClient } from "@tanstack/react-query";
import { retryStuckStage } from "../client";
export function useRetryStuck(runId: string) { const client = useQueryClient(); return useMutation({ mutationFn: (stageInstanceId: string) => retryStuckStage(stageInstanceId), onSuccess: () => { void client.invalidateQueries({ queryKey: ["oakridge", "run", runId] }); } }); }
