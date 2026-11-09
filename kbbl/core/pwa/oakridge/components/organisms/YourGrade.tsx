import { useEffect, useRef, useState } from "react";
import { Button } from "../../../components/atoms/Button";
import { FeedbackMessage } from "../../../components/atoms/FeedbackMessage";
import type { AnswerRead, QuestionStatus, SubmissionResult } from "../../grading-types";
import { useOwnAnswers } from "../../hooks/useOwnAnswers";
import { useReviewer } from "../../hooks/useReviewer";
import { useSubmitAnswer } from "../../hooks/useSubmitAnswer";
import { answerValueLabel, gradeAnswerLabel, questionLabel, selectHumanForm, selectOwnCurrentAnswer, selectSubmissionNotice } from "../../lib/grading";
import { randomUuid } from "../../../lib/random-uuid";
import { artifactLabelClass } from "../molecules/ArtifactSection";
import { AnswerRow } from "../molecules/ItemAnswers";

interface Props {
  occurrenceId: string;
  question: QuestionStatus;
  onAcknowledged: () => void;
}

const answerChoice = (answer: AnswerRead | null): string | null => answer?.answer.state === "answered" && typeof answer.answer.value === "string" ? answer.answer.value : null;

/**
 * The operator's own answer. It stays usable whatever is hidden and needs only this question to be
 * ready. One submission id covers one chosen answer, so a retry after a lost reply lands on the same
 * record; changing the answer is a new submission. It says saved only on an acknowledgment.
 */
export function YourGrade({ occurrenceId, question, onAcknowledged }: Props) {
  const reviewer = useReviewer();
  const key = { question_id: question.question.question_id, question_version: question.question.question_version };
  const own = useOwnAnswers(occurrenceId, key, reviewer.data?.reviewer_id ?? null);
  const current = selectOwnCurrentAnswer(own.data ?? []);
  const earlier = (own.data ?? []).filter((answer) => answer.observation_id !== current?.observation_id);
  const form = selectHumanForm(question.human, question.question.allowed_values);
  const [choice, setChoice] = useState<string | null>(null);
  const [rationale, setRationale] = useState("");
  const submissionId = useRef(randomUuid());
  const submit = useSubmitAnswer(occurrenceId, onAcknowledged);
  const notice = selectSubmissionNotice({ is_pending: submit.isPending, result: submit.data as SubmissionResult | undefined });
  useEffect(() => { submit.reset(); setChoice(null); setRationale(""); submissionId.current = randomUuid(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [key.question_id, key.question_version]);
  const shown = choice ?? answerChoice(current);
  const isChanged = choice !== null && choice !== answerChoice(current);
  const changed = (next: () => void) => { next(); submit.reset(); submissionId.current = randomUuid(); };
  return (
    <section className="flex flex-col gap-2" data-testid="or-your-grade">
      <div className={artifactLabelClass}>Your grade: {questionLabel(question.question)}</div>
      {form.kind === "not_ready" && <p className="m-0 text-sm text-[var(--text-muted)]" data-testid="or-your-grade-not-ready">Not ready to answer: {form.detail} ({form.code})</p>}
      {form.kind === "unavailable" && <p className="m-0 text-sm text-[var(--text-muted)]">{form.detail}</p>}
      {form.kind === "open" && (
        <>
          <div className="flex flex-wrap gap-3" role="radiogroup" aria-label={`Your answer to ${questionLabel(question.question)}`}>
            {form.choices.map((value) => (
              <label key={value} className="flex items-center gap-1.5 text-sm text-[var(--text-secondary)]">
                <input type="radio" name={`or-your-grade-${key.question_id}`} value={value} checked={shown === value} onChange={() => changed(() => setChoice(value))} data-testid="or-your-grade-choice" />
                {answerValueLabel(value)}
              </label>
            ))}
          </div>
          <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
            Rationale (optional)
            <textarea className="rounded-md border border-[var(--border-muted)] bg-[var(--bg-surface)] p-2 text-sm text-[var(--text-primary)]" rows={2} value={rationale}
              onChange={(event) => changed(() => setRationale(event.target.value))} data-testid="or-your-grade-rationale" />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" size="xsmall" disabled={!isChanged || submit.isPending || reviewer.isError} data-testid="or-your-grade-submit"
              onClick={() => { if (choice) submit.mutate({ ...key, submission_id: submissionId.current, answer: choice, rationale: rationale.trim() === "" ? null : rationale,
                corrects_observation_id: current?.observation_id ?? null }); }}>
              {current ? "Correct your answer" : "Save answer"}
            </Button>
            {notice.kind === "pending" && <span className="text-xs text-[var(--text-muted)]" data-testid="or-your-grade-pending">Sending…</span>}
            {notice.kind === "saved" && <span className="text-xs text-[var(--success-fg)]" data-testid="or-your-grade-saved">Saved: {notice.answer}</span>}
          </div>
          {notice.kind === "refused" && <FeedbackMessage tone="danger" testId="or-your-grade-refused">Not saved: {notice.message}</FeedbackMessage>}
          {notice.kind === "failed" && <FeedbackMessage tone="danger" testId="or-your-grade-failed">Not confirmed saved: {notice.message}</FeedbackMessage>}
          {reviewer.isError && <FeedbackMessage tone="danger" testId="or-your-grade-no-reviewer">This server cannot submit grades: {reviewer.error instanceof Error ? reviewer.error.message : "no grade capability"}</FeedbackMessage>}
        </>
      )}
      {current && <p className="m-0 text-xs text-[var(--text-muted)]" data-testid="or-your-grade-current">Your current answer: {gradeAnswerLabel(current.answer)}</p>}
      {earlier.length > 0 && <ul className="m-0 list-none divide-y divide-[var(--border-subtle)] p-0" data-testid="or-your-grade-history">
        {earlier.map((answer) => <AnswerRow key={answer.observation_id} answer={answer} isCorrected />)}
      </ul>}
    </section>
  );
}
