import { useState } from "react";
import { Button } from "../../../components/atoms/Button";
import { Chip } from "../../../components/atoms/Chip";
import { FeedbackMessage } from "../../../components/atoms/FeedbackMessage";
import type { WindowQuery } from "../../client-grading";
import type { DrilldownKey, ItemSelection, PageWindow } from "../../grading-types";
import { useCompositeDrilldown } from "../../hooks/useCompositeDrilldown";
import { questionLabel, selectItemText, statusKeyLabel } from "../../lib/grading";
import { artifactLabelClass } from "../molecules/ArtifactSection";
import { GradeItemButton } from "../molecules/GradeItemButton";
import { AnswerRow } from "../molecules/ItemAnswers";
import { ListPager } from "../molecules/ListPager";

const FIRST: PageWindow = { limit: 20, offset: 0 };

interface Props {
  runId: string;
  drilldownKey: DrilldownKey;
  label: string;
  onClose: () => void;
  onOpenItem: (selection: ItemSelection) => void;
}

/** The exact items and raw answers behind one count. Mounted only while composites are revealed. */
export function CompositeDrilldown({ runId, drilldownKey, label, onClose, onOpenItem }: Props) {
  const [page, setPage] = useState(FIRST);
  const [windows, setWindows] = useState<WindowQuery>({});
  const query = useCompositeDrilldown(runId, drilldownKey, page, windows);
  const setWindow = (name: string) => (window: PageWindow) => setWindows((current) => ({ ...current, [name]: window }));
  return (
    <section className="flex flex-col gap-2 rounded-md border border-[var(--border-muted)] p-2" data-testid="or-task-drilldown">
      <div className="flex items-center gap-2">
        <h4 className="m-0 min-w-0 flex-1 text-sm font-semibold text-[var(--text-primary)]">{label}{query.data ? ` (${query.data.total})` : ""}</h4>
        <Button variant="secondary" size="xsmall" className="text-xs!" onClick={onClose} data-testid="or-task-drilldown-close">Close</Button>
      </div>
      {query.isError && <FeedbackMessage tone="danger">{query.error instanceof Error ? query.error.message : "observation did not answer"}</FeedbackMessage>}
      <ul className="m-0 list-none divide-y divide-[var(--border-subtle)] p-0">
        {query.data?.items.map((row) => (
          <li key={row.item.occurrence_id} className="flex flex-col gap-2 py-2" data-testid="or-task-drilldown-row" data-item-path={row.item.item_path} data-revision={row.item.source_revision_id}>
            <div className="flex items-start gap-2">
              <p className="m-0 min-w-0 flex-1 text-sm text-[var(--text-secondary)]">{selectItemText(row.item.selected_value)}</p>
              <GradeItemButton selection={{ source_revision_id: row.item.source_revision_id, item_path: row.item.item_path }} onOpenItem={onOpenItem} />
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-[var(--text-muted)]">
              <code className="or-code">{row.item.source_revision_id} {row.item.item_path}</code>
              {!row.item.is_current && <Chip tone="muted">Older revision</Chip>}
            </div>
            {row.questions.items.map((question) => (
              <div key={question.evidence.evidence_set_id} className="flex flex-col gap-1">
                <div className={artifactLabelClass}>{questionLabel(question.question)} · {question.evidence.references.total} frozen references</div>
                <ul className="m-0 list-none divide-y divide-[var(--border-subtle)] p-0">
                  {question.answers.items.map((answer) => <AnswerRow key={answer.observation_id} answer={answer} />)}
                  {question.superseded_answers.items.map((answer) => <AnswerRow key={answer.observation_id} answer={answer} isCorrected />)}
                </ul>
                <ul className="m-0 flex list-none flex-wrap gap-1 p-0">
                  {question.statuses.items.map((status, index) => <li key={`${status.evaluator_definition_id}-${index}`}><Chip tone="muted">{statusKeyLabel(status.status)}</Chip></li>)}
                </ul>
                <ListPager name="answers" page={question.answers} onWindow={setWindow("answers")} />
                <ListPager name="superseded_answers" page={question.superseded_answers} onWindow={setWindow("superseded_answers")} />
                <ListPager name="statuses" page={question.statuses} onWindow={setWindow("statuses")} />
                <ListPager name="references" page={question.evidence.references} onWindow={setWindow("references")} />
              </div>
            ))}
            <ListPager name="questions" page={row.questions} onWindow={setWindow("questions")} />
            <ListPager name="links" page={row.links} onWindow={setWindow("links")} />
          </li>
        ))}
      </ul>
      {query.data && <ListPager name="drilldown" page={query.data} onWindow={setPage} />}
    </section>
  );
}
