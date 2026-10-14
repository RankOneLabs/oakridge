import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createOperatorThread } from "../client";
import { invalidateThreads } from "../lib/operator-invalidation";

export function useCreateOperatorThread() {
  const client = useQueryClient();
  return useMutation({ mutationFn: createOperatorThread,
    onSuccess: (_thread, input) => invalidateThreads(client, input.run_id, input.unit_id, input.revision_id) });
}
