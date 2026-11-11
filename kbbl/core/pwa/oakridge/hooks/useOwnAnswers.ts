import { useQuery } from "@tanstack/react-query";
import type { ObservationItemOccurrenceId, ObservationLogicalItemId, ObservationReviewerId } from "../grading-contracts/domain/identity";
import { readAnswersPage } from "../client-grading";
import type { ObservationAnswerRead } from "../grading-contracts/grading/item-reads";
import type { ObservationQuestionKey } from "../grading-contracts/grading/question";

const PAGE = 200;
/** Every answer this reviewer gave one question, followed to its end so the current one is never on an unread page. */
export function useOwnAnswers(occurrence_id: ObservationItemOccurrenceId | null, question: ObservationQuestionKey | null, reviewer_id: ObservationReviewerId | null, task_id: ObservationLogicalItemId | null = null) {
  return useQuery({ queryKey: ["oakridge", "grading", "own-answers", occurrence_id, task_id, question?.question_id, question?.question_version, reviewer_id],
    enabled: occurrence_id !== null && question !== null && reviewer_id !== null,
    queryFn: async () => {
      const answers: ObservationAnswerRead[] = [];
      if (occurrence_id === null || question === null || reviewer_id === null) return answers;
      for (let offset = 0; ; offset += PAGE) {
        const page = await readAnswersPage(occurrence_id, { question, reviewer_id, task_id }, { limit: PAGE, offset });
        answers.push(...page.items);
        if (answers.length >= page.total || page.items.length === 0) return answers;
      }
    },
  });
}
