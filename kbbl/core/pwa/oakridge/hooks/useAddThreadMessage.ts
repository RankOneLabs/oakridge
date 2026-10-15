import { useMutation, useQueryClient } from "@tanstack/react-query";
import { addOperatorMessage } from "../client";
import { invalidateThreads } from "../lib/operator-invalidation";

/** Post a reply to a thread, then refetch the revision's threads. */
export function useAddThreadMessage(runId: string, unitId: string, revisionId: string) {
  const client = useQueryClient();
  return useMutation({ mutationFn: addOperatorMessage,
    onSuccess: () => invalidateThreads(client, runId, unitId, revisionId) });
}
