import { useMutation, useQueryClient } from "@tanstack/react-query";
import { unarchiveRun } from "../client";
export function useUnarchiveRun(runId: string) { const client = useQueryClient(); return useMutation({ mutationFn: () => unarchiveRun(runId), onSuccess: () => { void client.invalidateQueries({ queryKey: ["oakridge", "runs"] }); void client.invalidateQueries({ queryKey: ["oakridge", "run", runId] }); } }); }
