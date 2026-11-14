import { selectAssociationGradeGroups, selectSharedGradePage } from "../../lib/task-association-grades";
import { useState } from "react";
import type { ObservationItemOccurrenceId, ObservationLogicalItemId } from "../../grading-contracts/domain/identity";
import type { ObservationPageRequest } from "../../grading-contracts/grading/composite";
import { useItemStatus } from "../../hooks/useItemStatus";
import type { WindowQuery } from "../../client-grading";
import { measurementDisplay, questionLabel } from "../../lib/grading";
import { AnswerRow } from "../molecules/ItemAnswers";
import { ListPager } from "../molecules/ListPager";

interface Props {
  occurrenceId: ObservationItemOccurrenceId;
  taskId: ObservationLogicalItemId | null;
}
const FIRST: ObservationPageRequest = { limit: 50, offset: 0 };
/** Independent observations, shown only after the operator reveals grades. Never aggregate scopes. */
export function TaskAssociationGrades({ occurrenceId, taskId }: Props) {
  const [page, setPage] = useState(FIRST);
  const [nested, setNested] = useState<WindowQuery>({});
  const status = useItemStatus({ occurrence_id: occurrenceId, top: page, nested });
  const setWindow = (name: string, window: ObservationPageRequest) => setNested((current) => ({ ...current, [name]: window }));
  return <section aria-label="Independent grades" className="basis-full text-xs">
    {status.isPending && <p>Loading independent grades…</p>}
    {status.isError && <p>Independent grades unavailable.</p>}
    {status.data && <>
      {selectAssociationGradeGroups(status.data.questions.items, taskId).map(({ scope, questions }) => <section key={scope} aria-label={`${scope} grades`}>
        <h5>{scope}</h5>
        <ul>{questions.map((question) => <li key={question.evidence.evidence_set_id}>
          <p>{questionLabel(question.question)}</p>
          {question.answers.total === 0 && <p>No independent answers recorded.</p>}
          <ul>{question.answers.items.map((answer) => <AnswerRow key={answer.observation_id} answer={answer} />)}</ul>
          <ul>{question.machine.items.map((machine) => <li key={machine.evaluator_definition_id}>{machine.backend_kind}: {measurementDisplay(machine.measurement).label}</li>)}</ul>
        </li>)}</ul>
      </section>)}
      <p>Answer and machine pages apply to all displayed questions.</p>
      <ListPager name="all-question-answers" page={selectSharedGradePage(status.data.questions.items, "answers", nested.answers)} onWindow={(window) => setWindow("answers", window)} />
      <ListPager name="all-question-machine" page={selectSharedGradePage(status.data.questions.items, "machine", nested.machine)} onWindow={(window) => setWindow("machine", window)} />
      <ListPager name="association-questions" page={status.data.questions} onWindow={(window) => { setPage(window); setNested({}); }} />
    </>}
  </section>;
}
