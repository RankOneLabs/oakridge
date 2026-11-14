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
  const status = useItemStatus({ occurrence_id: occurrenceId, top: page, nested }, { refetchInterval: false });
  const setWindow = (name: string, window: ObservationPageRequest) => setNested((current) => ({ ...current, [name]: window }));
  return <section aria-label="Independent grades" className="basis-full text-xs">
    {status.isPending && <p>Loading independent grades…</p>}
    {status.isError && <p>Independent grades unavailable.</p>}
    {status.data && <>
      {(["per_item", "per_task"] as const).map((scope) => <section key={scope} aria-label={`${scope} grades`}>
        <h5>{scope}</h5>
        <ul>{status.data.questions.items.filter((question) => scope === "per_item" ? question.task_id === null : taskId !== null && question.task_id === taskId).map((question) => <li key={question.evidence.evidence_set_id}>
          <p>{questionLabel(question.question)}</p>
          {question.answers.total === 0 && <p>No independent answers recorded.</p>}
          <ul>{question.answers.items.map((answer) => <AnswerRow key={answer.observation_id} answer={answer} />)}</ul>
          <ListPager name={`${scope}-answers`} page={question.answers} onWindow={(window) => setWindow("answers", window)} />
          <ul>{question.machine.items.map((machine) => <li key={machine.evaluator_definition_id}>{machine.backend_kind}: {measurementDisplay(machine.measurement).label}</li>)}</ul>
          <ListPager name={`${scope}-machine`} page={question.machine} onWindow={(window) => setWindow("machine", window)} />
        </li>)}</ul>
      </section>)}
      <ListPager name="association-questions" page={status.data.questions} onWindow={(window) => { setPage(window); setNested({}); }} />
    </>}
  </section>;
}
