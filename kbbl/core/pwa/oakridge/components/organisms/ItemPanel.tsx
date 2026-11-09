import { useState } from "react";
import { Button } from "../../../components/atoms/Button";
import { Chip } from "../../../components/atoms/Chip";
import { FeedbackMessage } from "../../../components/atoms/FeedbackMessage";
import { GradingReadError, type WindowQuery } from "../../client-grading";
import type { ObservationPageRequest } from "../../grading-contracts/grading/composite";
import type { ObservationItemAddress } from "../../grading-contracts/grading/item-reads";
import { useItemAt } from "../../hooks/useItemAt";
import { useItemLineage } from "../../hooks/useItemLineage";
import { useItemStatus } from "../../hooks/useItemStatus";
import { itemSelectionKey, questionLabel, sameQuestion, selectItemText, stageLabel, taskLinkLabel } from "../../lib/grading";
import { useGradingVisibility } from "../../state/gradingVisibility";
import { artifactLabelClass } from "../molecules/ArtifactSection";
import { FrozenEvidenceList } from "../molecules/FrozenEvidenceList";
import { ItemAnswers } from "../molecules/ItemAnswers";
import { ListPager } from "../molecules/ListPager";
import { YourGrade } from "./YourGrade";

const QUESTIONS: ObservationPageRequest = { limit: 200, offset: 0 };
const FIRST_LINEAGE: ObservationPageRequest = { limit: 20, offset: 0 };

interface Props {
  runId: string;
  selection: ObservationItemAddress;
  onOpenTask: (task_id: string) => void;
}

function Unavailable({ error }: { error: unknown }) {
  if (error instanceof GradingReadError && error.status === 404) {
    return <FeedbackMessage testId="or-item-not-captured">This item has not been captured. Grading opens once observation has captured this revision.</FeedbackMessage>;
  }
  return <FeedbackMessage tone="danger" testId="or-item-unavailable">Grading is unavailable: {error instanceof Error ? error.message : "observation did not answer"}</FeedbackMessage>;
}

/**
 * One item, whichever viewer opened it: exact revision and path in, and its questions, frozen
 * evidence, lineage, answers and Your grade out. It carries no approval control and asks nothing
 * about tasks; a task link here is navigation only.
 */
export function ItemPanel({ runId, selection, onOpenTask }: Props) {
  const key = itemSelectionKey(selection);
  const isRevealed = useGradingVisibility((state) => state.revealed_item_keys.has(key));
  const reveal = useGradingVisibility((state) => state.revealItem);
  const hide = useGradingVisibility((state) => state.hideItem);
  const address = useItemAt(runId, selection);
  const occurrenceId = address.data?.occurrence_id ?? null;
  const [windows, setWindows] = useState<WindowQuery>({});
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [lineagePage, setLineagePage] = useState(FIRST_LINEAGE);
  const status = useItemStatus(occurrenceId === null ? null : { occurrence_id: occurrenceId, top: QUESTIONS, nested: windows });
  const lineage = useItemLineage(occurrenceId, lineagePage);
  const setWindow = (name: string, window: ObservationPageRequest) => setWindows((current) => ({ ...current, [name]: window }));

  if (address.isError) return <Unavailable error={address.error} />;
  if (status.isError) return <Unavailable error={status.error} />;
  if (!status.data) return <FeedbackMessage testId="or-item-loading">Loading item…</FeedbackMessage>;

  const { item, links, questions, is_grading_enabled: isGradingEnabled } = status.data;
  const question = questions.items[Math.min(selectedIndex, Math.max(0, questions.items.length - 1))] ?? null;
  return (
    <article className="flex flex-col gap-4 p-3" data-testid="or-item-panel" data-occurrence={item.occurrence_id} data-item-path={item.item_path} data-revision={item.source_revision_id}>
      <header className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
          <Chip tone="neutral">{stageLabel(item.stage)}</Chip>
          <code className="or-code">{item.source_revision_id}</code>
          <code className="or-code">{item.item_path}</code>
          {!item.is_current && <Chip tone="muted">Older revision</Chip>}
          {!isGradingEnabled && <Chip tone="muted" testId="or-item-grading-off">Automatic grading off</Chip>}
        </div>
        <p className="m-0 whitespace-pre-wrap text-sm text-[var(--text-primary)]">{selectItemText(item.selected_value)}</p>
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-[var(--text-muted)]" data-testid="or-item-task-links">
          <span>Tasks</span>
          {links.total === 0 && <Chip tone="muted">None linked</Chip>}
          {links.items.map((link) => (
            <Button key={link.relation_id} variant="secondary" size="xsmall" className="text-xs!" onClick={() => onOpenTask(link.producer_local_id)} data-testid="or-item-task-link" data-link-state={link.state}>{taskLinkLabel(link)}</Button>
          ))}
          <ListPager name="links" page={links} onWindow={(window) => setWindow("links", window)} />
        </div>
      </header>

      {questions.total === 0 ? <p className="m-0 text-sm text-[var(--text-muted)]" data-testid="or-item-no-questions">No question was pinned to this item.</p> : (
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Questions">
          {questions.items.map((candidate, index) => (
            <Button key={`${candidate.question.question_id}@${candidate.question.question_version}`} variant={question && sameQuestion(candidate.question, question.question) ? "primary" : "secondary"} size="xsmall" className="text-xs!"
              role="tab" aria-selected={question !== null && sameQuestion(candidate.question, question.question)} data-testid="or-item-question" data-question={candidate.question.question_id} data-readiness={candidate.human.state}
              onClick={() => { setSelectedIndex(index); setWindows({}); }}>
              {questionLabel(candidate.question)}{candidate.human.state === "not_ready" ? " (not ready)" : ""}
            </Button>
          ))}
        </div>
      )}

      {question && (
        <>
          <section className="flex flex-col gap-1" data-testid="or-item-question-text">
            <p className="m-0 text-sm font-medium text-[var(--text-primary)]">{question.question.question_text ?? questionLabel(question.question)}</p>
            <p className="m-0 text-xs text-[var(--text-muted)]">{question.question.interpretation_caveats}</p>
          </section>
          <YourGrade occurrenceId={item.occurrence_id} question={question} onAcknowledged={() => reveal(key)} />
          <div className="flex flex-wrap items-center gap-2">
            {isRevealed
              ? <Button variant="secondary" size="xsmall" className="text-xs!" onClick={() => hide(key)} data-testid="or-item-hide">Hide other answers</Button>
              : <Button variant="secondary" size="xsmall" className="text-xs!" onClick={() => reveal(key)} data-testid="or-item-reveal">Reveal other answers</Button>}
          </div>
          {isRevealed
            ? <ItemAnswers question={question} onWindow={setWindow} />
            : <p className="m-0 text-xs text-[var(--text-muted)]" data-testid="or-item-answers-hidden">Other answers are hidden.</p>}
          <FrozenEvidenceList evidence={question.evidence} onWindow={(window) => setWindow("references", window)} />
        </>
      )}

      <section className="flex flex-col gap-1" data-testid="or-item-lineage">
        <div className={artifactLabelClass}>Lineage</div>
        {lineage.data?.republication && <p className="m-0 text-xs text-[var(--text-muted)]">Follows {lineage.data.republication.predecessor_revision_id}{lineage.data.republication.is_republication ? ", republished unchanged" : ""}.</p>}
        {lineage.data?.total === 0 && <p className="m-0 text-xs text-[var(--text-muted)]">No related items.</p>}
        <ul className="m-0 list-none p-0 text-xs text-[var(--text-secondary)]">
          {lineage.data?.relations.map((relation) => (
            <li key={relation.relation_id} data-testid="or-item-lineage-edge">{relation.type} <code className="or-code">{relation.unresolved_target_ref ?? relation.target_logical_item_id ?? relation.target_occurrence_id}</code> <span className="text-[var(--text-muted)]">({relation.evidence_ref})</span></li>
          ))}
        </ul>
        {lineage.data && <ListPager name="lineage" page={lineage.data} onWindow={setLineagePage} />}
      </section>
    </article>
  );
}
