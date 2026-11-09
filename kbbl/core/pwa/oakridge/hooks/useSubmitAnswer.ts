import { useMutation, useQueryClient } from "@tanstack/react-query";
import { submitAnswer } from "../client-grading";
import type { AnswerSubmission, SubmissionResult } from "../grading-types";

/** One lifecycle per form. Only an acknowledgment refreshes the reads and tells the caller to reveal. */
export function useSubmitAnswer(occurrence_id: string, onAcknowledged: () => void) {
  const client = useQueryClient();
  return useMutation<SubmissionResult, never, AnswerSubmission>({ mutationFn: (submission) => submitAnswer(occurrence_id, submission),
    onSuccess: (result) => {
      if (result.kind !== "acknowledged") return;
      onAcknowledged();
      void client.invalidateQueries({ queryKey: ["oakridge", "grading"] });
    } });
}
