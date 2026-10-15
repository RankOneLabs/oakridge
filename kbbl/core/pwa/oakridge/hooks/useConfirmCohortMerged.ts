import { useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { confirmCohortMerged } from "../client";
import { selectRequestIdentity, type PendingRequestIdentity } from "../lib/request-identity";
import { randomUuid } from "../../lib/random-uuid";

interface ConfirmCohortMergedInput {
  cohortId: string;
  operatorComment: string;
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
  const requestKeys = useRef(new Map<string, PendingRequestIdentity>());
  return useMutation({
    mutationFn: ({ cohortId, operatorComment }: ConfirmCohortMergedInput) => {
      const pending = selectRequestIdentity(requestKeys.current.get(cohortId) ?? null, cohortId, randomUuid);
      requestKeys.current.set(cohortId, pending);
      return confirmCohortMerged(cohortId, { idempotency_key: pending.idempotency_key, operator_comment: operatorComment });
    },
    onSuccess: (_data, { cohortId }) => {
      requestKeys.current.delete(cohortId);
      void client.invalidateQueries({ queryKey: ["oakridge", "run", runId] });
      void client.invalidateQueries({ queryKey: ["oakridge", "runs"] });
      void client.invalidateQueries({ queryKey: ["oakridge", "review-inbox"] });
    },
  });
}
