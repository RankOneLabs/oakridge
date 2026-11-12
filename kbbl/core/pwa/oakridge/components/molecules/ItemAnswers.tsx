import { Chip } from "../../../components/atoms/Chip";
import type { ObservationAnswerDetail, ObservationPageRequest } from "../../grading-contracts/grading/composite";
import type { ObservationQuestionStatusResponse } from "../../grading-contracts/storage/grading-record-store";
import { answerTone, attemptDisplay, gradeAnswerLabel, graderLabel, measurementDisplay } from "../../lib/grading";
import { artifactLabelClass } from "./ArtifactSection";
import { ListPager } from "./ListPager";

export function AnswerRow({ answer, isCorrected = false }: { answer: ObservationAnswerDetail; isCorrected?: boolean }) {
  return (
    <li className="flex flex-col gap-1 py-1.5" data-testid="or-item-answer" data-observation={answer.observation_id} data-grader={answer.grader.kind} data-corrected={isCorrected}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-[var(--text-secondary)]">{graderLabel(answer.grader)}</span>
        <Chip tone={answer.answer.state === "answered" ? answerTone(answer.answer.value) : "neutral"}>{gradeAnswerLabel(answer.answer)}</Chip>
        {isCorrected && <span className="text-xs text-[var(--text-muted)]">Corrected</span>}
      </div>
      {answer.rationale && <p className="m-0 text-xs text-[var(--text-muted)]">{answer.rationale}</p>}
    </li>
  );
}

interface Props {
  question: ObservationQuestionStatusResponse;
  onWindow: (name: "machine" | "attempts" | "answers" | "superseded_answers", window: ObservationPageRequest) => void;
}

/** Every evaluator's status and every answer. Rendered only when revealed, so hidden mode has nothing here to leak. */
export function ItemAnswers({ question, onWindow }: Props) {
  return (
    <section className="flex flex-col gap-3" data-testid="or-item-answers">
      <div className="flex flex-col gap-1">
        <div className={artifactLabelClass}>Automatic evaluators ({question.machine.total})</div>
        {question.machine.total === 0 && <p className="text-sm text-[var(--text-muted)]">No automatic evaluator is pinned to this question.</p>}
        <ul className="m-0 list-none divide-y divide-[var(--border-decorative)] p-0">
          {question.machine.items.map((machine) => {
            const display = measurementDisplay(machine.measurement);
            return (
              <li key={machine.evaluator_definition_id} className="flex flex-col gap-1 py-1.5" data-testid="or-item-machine-status" data-state={machine.measurement.state}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-[var(--text-secondary)]">{machine.model ? `${machine.backend_kind} (${machine.model})` : machine.backend_kind}</span>
                  <Chip tone={display.tone}>{display.label}</Chip>
                  <span className="text-xs text-[var(--text-muted)]">{machine.attempts.total} {machine.attempts.total === 1 ? "attempt" : "attempts"}</span>
                </div>
                {display.detail && <p className="m-0 text-xs text-[var(--text-muted)]">{display.detail}</p>}
                <ul className="m-0 flex list-none flex-col gap-1 p-0 pl-2">
                  {machine.attempts.items.map((attempt) => {
                    const shown = attemptDisplay(attempt);
                    return (
                      <li key={attempt.attempt} className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]" data-testid="or-item-attempt" data-attempt={attempt.attempt}>
                        <span>{shown.label}</span>
                        <Chip tone={shown.tone}>{shown.outcome}</Chip>
                        {shown.failure_category && <code className="or-code">{shown.failure_category}</code>}
                        <span>{shown.request}</span>
                        <span>{shown.cost}</span>
                      </li>
                    );
                  })}
                </ul>
                <ListPager name="attempts" page={machine.attempts} onWindow={(window) => onWindow("attempts", window)} />
              </li>
            );
          })}
        </ul>
        <ListPager name="machine" page={question.machine} onWindow={(window) => onWindow("machine", window)} />
      </div>
      <div className="flex flex-col gap-1">
        <div className={artifactLabelClass}>Answers ({question.answers.total})</div>
        {question.answers.total === 0 && <p className="text-sm text-[var(--text-muted)]">No answer has been recorded.</p>}
        <ul className="m-0 list-none divide-y divide-[var(--border-decorative)] p-0">
          {question.answers.items.map((answer) => <AnswerRow key={answer.observation_id} answer={answer} />)}
        </ul>
        <ListPager name="answers" page={question.answers} onWindow={(window) => onWindow("answers", window)} />
      </div>
      {question.superseded_answers.total > 0 && (
        <div className="flex flex-col gap-1">
          <div className={artifactLabelClass}>Correction history ({question.superseded_answers.total})</div>
          <ul className="m-0 list-none divide-y divide-[var(--border-decorative)] p-0" data-testid="or-item-answer-history">
            {question.superseded_answers.items.map((answer) => <AnswerRow key={answer.observation_id} answer={answer} isCorrected />)}
          </ul>
          <ListPager name="superseded_answers" page={question.superseded_answers} onWindow={(window) => onWindow("superseded_answers", window)} />
        </div>
      )}
    </section>
  );
}
