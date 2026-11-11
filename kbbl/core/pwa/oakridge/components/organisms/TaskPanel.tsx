import { useState } from "react";
import { Button } from "../../../components/atoms/Button";
import { Chip } from "../../../components/atoms/Chip";
import { FeedbackMessage } from "../../../components/atoms/FeedbackMessage";
import { GradingReadError } from "../../client-grading";
import type { ObservationCompositeDrilldownKey, ObservationPageRequest } from "../../grading-contracts/grading/composite";
import type { ObservationItemAddress } from "../../grading-contracts/grading/item-reads";
import { useTask } from "../../hooks/useTask";
import { useTaskLineage } from "../../hooks/useTaskLineage";
import { selectItemText, selectTaskContributionSelection } from "../../lib/grading";
import { useGradingVisibility } from "../../state/gradingVisibility";
import { artifactLabelClass } from "../molecules/ArtifactSection";
import { GradeItemButton } from "../molecules/GradeItemButton";
import { ListPager } from "../molecules/ListPager";
import { CompositeDrilldown } from "./CompositeDrilldown";
import { TaskStageComposites } from "./TaskStageComposites";
import { ItemGradeAction } from "./ItemGradeAction";

const FIRST: ObservationPageRequest = { limit: 50, offset: 0 };

interface Props {
  runId: string;
  taskId: string;
  onOpenItem: (selection: ObservationItemAddress) => void;
}

/** One run-scoped task: its stages side by side and the items linked to it. A task is read, never answered. */
export function TaskPanel({ runId, taskId, onOpenItem }: Props) {
  const isRevealed = useGradingVisibility((state) => state.revealed_composite_run_ids.has(runId));
  const reveal = useGradingVisibility((state) => state.revealComposites);
  const hide = useGradingVisibility((state) => state.hideComposites);
  const [lineagePage, setLineagePage] = useState(FIRST);
  const [drill, setDrill] = useState<{ readonly key: ObservationCompositeDrilldownKey; readonly label: string } | null>(null);
  const composite = useTask({ run_id: runId, task_id: taskId, nested: {} });
  const lineage = useTaskLineage(runId, taskId, lineagePage);
  const isUncaptured = composite.error instanceof GradingReadError && composite.error.status === 404;
  return (
    <article className="flex flex-col gap-4 p-3" data-testid="or-task-panel" data-task={taskId}>
      <header className="flex flex-wrap items-center gap-2">
        <code className="or-code">{taskId}</code>
        {composite.data?.coverage === "gap" && <Chip tone="warning" testId="or-task-coverage-gap-all">No linked items</Chip>}
        {isRevealed
          ? <Button variant="secondary" size="xsmall" className="text-xs!" onClick={() => { hide(runId); setDrill(null); }} data-testid="or-composites-hide">Hide composites</Button>
          : <Button variant="secondary" size="xsmall" className="text-xs!" onClick={() => reveal(runId)} data-testid="or-composites-reveal">Reveal composites</Button>}
      </header>
      {isUncaptured && <FeedbackMessage testId="or-task-unresolved">This run has captured no task with this id. Items naming it stay listed below, unresolved.</FeedbackMessage>}
      {composite.isError && !isUncaptured && <FeedbackMessage tone="danger" testId="or-task-unavailable">{composite.error instanceof Error ? composite.error.message : "observation did not answer"}</FeedbackMessage>}
      {composite.data && <TaskStageComposites runId={runId} taskId={taskId} stages={composite.data.stages} isRevealed={isRevealed} onDrill={(key, label) => setDrill({ key, label })} />}
      {isRevealed && drill && <CompositeDrilldown runId={runId} drilldownKey={drill.key} label={drill.label} onClose={() => setDrill(null)} onOpenItem={onOpenItem} />}
      <section className="flex flex-col gap-1" data-testid="or-task-lineage">
        <div className={artifactLabelClass}>Spec task and cohort contributions</div>
        <ul className="m-0 list-none divide-y divide-[var(--border-subtle)] p-0">
          {lineage.data?.items.flatMap((entry, index) => {
            if (entry.kind === "edge") return [];
            if (entry.kind === "occurrence") return [<li key={`${index}-${entry.occurrence_id}`} className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-xs text-[var(--text-muted)]" data-testid="or-task-definition">
              <span>{entry.artifact_kind === "tasks" ? "Spec task" : "Cohort contribution"} · {entry.artifact_kind}{entry.is_current ? "" : " (older revision)"}</span>
              <ItemGradeAction runId={runId} selection={{ source_revision_id: entry.revision_id, item_path: entry.item_path }} onOpenItem={onOpenItem} />
            </li>];
            return [<li key={`${index}-${entry.relation_id}`} className="flex items-start gap-2 py-1.5" data-testid="or-task-linked-item" data-link-state={entry.kind}>
              <p className="m-0 min-w-0 flex-1 text-sm text-[var(--text-secondary)]">{selectItemText(entry.item.selected_value)}</p>
              {entry.kind === "unresolved" && <Chip tone="warning">Unresolved</Chip>}
              {!entry.item.is_current && <Chip tone="muted">Older revision</Chip>}
              <GradeItemButton selection={selectTaskContributionSelection(entry, composite.data?.logical_item_id ?? null)} onOpenItem={onOpenItem} />
            </li>];
          })}
        </ul>
        {lineage.isError && <FeedbackMessage tone="danger">{lineage.error instanceof Error ? lineage.error.message : "observation did not answer"}</FeedbackMessage>}
        {lineage.data && <ListPager name="task-lineage" page={lineage.data} onWindow={setLineagePage} />}
      </section>
    </article>
  );
}
