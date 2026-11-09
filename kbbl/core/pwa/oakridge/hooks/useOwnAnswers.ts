import { useQuery } from "@tanstack/react-query";
import { readAnswersPage } from "../client-grading";
import type { AnswerRead, QuestionKey } from "../grading-types";

const PAGE = 200;
/** Every answer this reviewer gave one question, followed to its end so the current one is never on an unread page. */
export function useOwnAnswers(occurrence_id: string | null, question: QuestionKey | null, reviewer_id: string | null) {
  return useQuery({ queryKey: ["oakridge", "grading", "own-answers", occurrence_id, question?.question_id, question?.question_version, reviewer_id],
    enabled: occurrence_id !== null && question !== null && reviewer_id !== null,
    queryFn: async () => {
      const answers: AnswerRead[] = [];
      if (occurrence_id === null || question === null || reviewer_id === null) return answers;
      for (let offset = 0; ; offset += PAGE) {
        const page = await readAnswersPage(occurrence_id, { question, reviewer_id }, { limit: PAGE, offset });
        answers.push(...page.items);
        if (answers.length >= page.total || page.items.length === 0) return answers;
      }
    },
  });
}
