import type { ObservationLogicalItemId } from "../grading-contracts/domain/identity";
import type { ObservationQuestionStatusRead } from "../grading-contracts/grading/item-reads";
import type { ObservationPageRequest } from "../grading-contracts/grading/composite";

export function selectAssociationGradeGroups<Measurement, Attempt>(questions: readonly ObservationQuestionStatusRead<Measurement, Attempt>[], taskId: ObservationLogicalItemId | null) {
  return (["per_item", "per_task"] as const).map((scope) => ({ scope, questions: questions.filter((question) => scope === "per_item" ? question.task_id === null : taskId !== null && question.task_id === taskId) }));
}
/** The API windows every question together; one explicitly shared pager represents that window. */
export function selectSharedGradePage<Measurement, Attempt>(questions: readonly ObservationQuestionStatusRead<Measurement, Attempt>[], list: "answers" | "machine", window?: ObservationPageRequest) {
  const first = questions[0]?.[list];
  return { limit: window?.limit ?? first?.limit ?? 50, offset: window?.offset ?? first?.offset ?? 0, total: Math.max(0, ...questions.map((question) => question[list].total)) };
}
