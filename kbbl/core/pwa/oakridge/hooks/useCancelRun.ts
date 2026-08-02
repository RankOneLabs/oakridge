import { useMutation, useQueryClient } from "@tanstack/react-query";
import { cancelRun } from "../client";
export function useCancelRun(runId: string) { const client = useQueryClient(); return useMutation({ mutationFn: () => cancelRun(runId), onSuccess: () => { void client.invalidateQueries({ queryKey: ["oakridge", "run", runId] }); void client.invalidateQueries({ queryKey: ["oakridge", "runs"] }); } }); }
