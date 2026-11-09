import { useMutation, useQueryClient } from "@tanstack/react-query";
import { submitAnswer } from "../client-grading";
import type { ObservationItemOccurrenceId } from "../grading-contracts/domain/identity";
import type { ObservationHumanSubmissionRequest } from "../grading-contracts/http/grades";
import type { SubmissionResult } from "../grading-types";
import { isStaleAnswerRefusal } from "../lib/grading";

/**
 * One lifecycle per form. Only an acknowledgment refreshes the reads and tells the caller to reveal.
 * A refusal saying this form's own answers are out of date refreshes them, and the submission stays
 * pending until they arrive, so the next one corrects the answer that now stands.
 */
export function useSubmitAnswer(occurrence_id: ObservationItemOccurrenceId, onAcknowledged: () => void) {
  const client = useQueryClient();
  return useMutation<SubmissionResult, never, ObservationHumanSubmissionRequest>({ mutationFn: (submission) => submitAnswer(occurrence_id, submission),
    onSuccess: async (result) => {
      if (isStaleAnswerRefusal(result)) return client.refetchQueries({ queryKey: ["oakridge", "grading", "own-answers", occurrence_id] });
      if (result.kind !== "acknowledged") return;
      onAcknowledged();
      void client.invalidateQueries({ queryKey: ["oakridge", "grading"] });
    } });
}
