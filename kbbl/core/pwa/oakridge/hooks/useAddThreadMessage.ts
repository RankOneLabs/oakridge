import { useMutation, useQueryClient } from "@tanstack/react-query";
import { addOperatorMessage } from "../client";
import { queryKeys } from "../queryKeys";

/** Post a reply to a thread, then refetch the revision's threads. */
export function useAddThreadMessage(runId: string, unitId: string, revisionId: string) {
  const client = useQueryClient();
  return useMutation({ mutationFn: addOperatorMessage,
    onSuccess: () => { void client.invalidateQueries({ queryKey: queryKeys.threads(runId, unitId, revisionId) }); } });
}
