import { useMutation, useQueryClient } from "@tanstack/react-query";

import { confirmCohortMerged } from "../client";

interface ConfirmCohortMergedInput {
  cohortId: string;
}

/** Requests a fresh verified merge observation; final approval uses a cohort request. */
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
