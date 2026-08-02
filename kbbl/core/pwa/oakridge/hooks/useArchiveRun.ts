import { useMutation, useQueryClient } from "@tanstack/react-query";
import { archiveRun } from "../client";
export function useArchiveRun(runId: string) { const client = useQueryClient(); return useMutation({ mutationFn: () => archiveRun(runId), onSuccess: () => { void client.invalidateQueries({ queryKey: ["oakridge", "runs"] }); void client.invalidateQueries({ queryKey: ["oakridge", "run", runId] }); } }); }
