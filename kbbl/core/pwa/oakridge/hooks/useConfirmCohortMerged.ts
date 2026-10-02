import { useMutation, useQueryClient } from "@tanstack/react-query";

import { confirmCohortMerged } from "../client";

interface ConfirmCohortMergedInput {
  cohortId: string;
  operatorComment?: string;
}

/**
 * The operator telling Oakridge a cohort's pull request merged.
 *
 * The normal path is the backend's GitHub poller; this is what an operator
 * reaches for when the poller cannot see the repository. The idempotency key is
 * held per cohort so a double click confirms once.
 */
export function useConfirmCohortMerged(runId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ cohortId }: ConfirmCohortMergedInput) => confirmCohortMerged(cohortId),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["oakridge", "run", runId] });
      void client.invalidateQueries({ queryKey: ["oakridge", "runs"] });
      void client.invalidateQueries({ queryKey: ["oakridge", "review-inbox"] });
    },
  });
}
