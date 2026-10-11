import { useMutation, useQueryClient } from "@tanstack/react-query";
import { addOperatorMessage } from "../client";
import { queryKeys } from "../queryKeys";

export function usePingThread(runId: string, scopeId: string, revisionId: string) {
  const client = useQueryClient();
  return useMutation({ mutationFn: addOperatorMessage,
    onSuccess: () => { void client.invalidateQueries({ queryKey: queryKeys.threads(runId, scopeId, revisionId) }); } });
}
