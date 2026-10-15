import { useMutation, useQueryClient } from "@tanstack/react-query";
import { submitOperatorDecision } from "../client";
import { invalidateRun } from "../lib/operator-invalidation";

export function useSubmitOperatorDecision() {
  const client = useQueryClient();
  return useMutation({ mutationFn: submitOperatorDecision,
    onSuccess: (_receipt, submission) => invalidateRun(client, submission.run_id) });
}
