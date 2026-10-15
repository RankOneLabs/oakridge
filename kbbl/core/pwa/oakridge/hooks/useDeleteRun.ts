import { useMutation, useQueryClient } from "@tanstack/react-query";
import { deleteRun } from "../client";
export function useDeleteRun(runId: string) { const client = useQueryClient(); return useMutation({ mutationFn: () => deleteRun(runId), onSuccess: () => { void client.invalidateQueries({ queryKey: ["oakridge", "runs"] }); } }); }
