import { useQuery } from "@tanstack/react-query";
import { readItemStatus } from "../client-grading";
import type { ObservationItemOccurrenceId, ObservationLogicalItemId } from "../grading-contracts/domain/identity";
import type { ObservationQuestionKey } from "../grading-contracts/grading/question";
import { sameQuestion } from "../lib/grading";
/** Locate a recorded question by identity even when it lives beyond the first questions page. */
export function usePinnedQuestionPage(occurrence_id: ObservationItemOccurrenceId | null, task_id: ObservationLogicalItemId | null | undefined, question: ObservationQuestionKey | null | undefined) {
  return useQuery({ queryKey: ["oakridge", "grading", "pinned-question-page", occurrence_id, task_id, question], enabled: occurrence_id !== null && question != null,
    queryFn: async () => {
      if (!occurrence_id || !question) return null;
      for (let offset = 0; ; offset += 200) {
        const top = { limit: 200, offset };
        const status = await readItemStatus({ occurrence_id, task_id, top, nested: {} });
        if (status.questions.items.some((candidate) => sameQuestion(candidate.question, question))) return top;
        if (offset + status.questions.items.length >= status.questions.total || status.questions.items.length === 0) return null;
      }
    }, retry: false });
}
