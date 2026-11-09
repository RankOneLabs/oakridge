import { useState } from "react";
import { Button } from "../../../components/atoms/Button";
import { Chip } from "../../../components/atoms/Chip";
import { FeedbackMessage } from "../../../components/atoms/FeedbackMessage";
import type { WindowQuery } from "../../client-grading";
import type { DrilldownKey, ItemSelection, PageWindow } from "../../grading-types";
import { useRunGrading } from "../../hooks/useRunGrading";
import { useRunTasks } from "../../hooks/useRunTasks";
import { useRunUnresolvedReferences } from "../../hooks/useRunUnresolvedReferences";
import { GRADING_STAGES, selectItemText } from "../../lib/grading";
import { useGradingVisibility } from "../../state/gradingVisibility";
import { GradeItemButton } from "../molecules/GradeItemButton";
import { ListPager } from "../molecules/ListPager";
import { StageCompositeColumn } from "../molecules/StageCompositeColumn";
import { CompositeDrilldown } from "./CompositeDrilldown";
import { StageFindings } from "./StageFindings";

const FIRST: PageWindow = { limit: 50, offset: 0 };

interface Props {
  runId: string;
  onOpenItem: (selection: ItemSelection) => void;
  onOpenTask: (task_id: string) => void;
}

/** Everything graded in a run: tasks with stage-separated composites, then each stage's findings, linked or not. */
export function RunGradingSection({ runId, onOpenItem, onOpenTask }: Props) {
  const isRevealed = useGradingVisibility((state) => state.revealed_composite_run_ids.has(runId));
  const reveal = useGradingVisibility((state) => state.revealComposites);
  const hide = useGradingVisibility((state) => state.hideComposites);
  const grading = useRunGrading(runId);
  const [taskPage, setTaskPage] = useState(FIRST);
  const [windows, setWindows] = useState<WindowQuery>({});
  const [drill, setDrill] = useState<{ readonly key: DrilldownKey; readonly label: string } | null>(null);
  const tasks = useRunTasks(runId, taskPage, windows);
  const [unresolvedPage, setUnresolvedPage] = useState(FIRST);
  const unresolved = useRunUnresolvedReferences(runId, unresolvedPage);
  return (
    <article className="flex flex-col gap-5 p-3" data-testid="or-grading-section">
      <header className="flex flex-wrap items-center gap-2">
        {grading.isError && <FeedbackMessage tone="muted" testId="or-grading-unavailable">Grading is unavailable: {grading.error instanceof Error ? grading.error.message : "observation did not answer"}</FeedbackMessage>}
        {grading.data && <Chip tone={grading.data.is_grading_enabled ? "info" : "muted"} testId="or-grading-state">Automatic grading {grading.data.is_grading_enabled ? "on" : "off"}</Chip>}
        {isRevealed && grading.data && <span className="text-xs text-[var(--text-muted)]" data-testid="or-grading-spend">{grading.data.requests_sent} provider requests · ${grading.data.committed.toFixed(2)} committed</span>}
        {isRevealed
          ? <Button variant="secondary" size="xsmall" className="text-xs!" onClick={() => { hide(runId); setDrill(null); }} data-testid="or-composites-hide">Hide composites</Button>
          : <Button variant="secondary" size="xsmall" className="text-xs!" onClick={() => reveal(runId)} data-testid="or-composites-reveal">Reveal composites</Button>}
      </header>

      <section className="flex flex-col gap-3" data-testid="or-grading-tasks">
        <h3 className="m-0 text-sm font-semibold text-[var(--text-primary)]">Tasks{tasks.data ? ` (${tasks.data.total})` : ""}</h3>
        {tasks.isError && <FeedbackMessage testId="or-grading-tasks-unavailable">Tasks are unavailable: {tasks.error instanceof Error ? tasks.error.message : "observation did not answer"}</FeedbackMessage>}
        {tasks.data?.total === 0 && <p className="m-0 text-sm text-[var(--text-muted)]">This run has no tasks yet. Findings are gradeable without one.</p>}
        {tasks.data?.items.map((task) => (
          <div key={task.logical_item_id} className="flex flex-col gap-2" data-testid="or-grading-task" data-task={task.producer_local_id}>
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="xsmall" className="text-xs!" onClick={() => onOpenTask(task.producer_local_id)} data-testid="or-grading-task-open">{task.producer_local_id}</Button>
              {task.coverage === "gap" && <Chip tone="warning" testId="or-task-coverage-gap-all">No linked items</Chip>}
            </div>
            <div className="grid gap-2 md:grid-cols-3">
              {task.stages.items.map((stage) => (
                <StageCompositeColumn key={stage.stage} stage={stage} isRevealed={isRevealed} onDrill={(key, label) => setDrill({ key, label })}
                  onWindow={(name, window) => setWindows((current) => ({ ...current, [name]: window }))} />
              ))}
            </div>
            <ListPager name="stages" page={task.stages} onWindow={(window) => setWindows((current) => ({ ...current, stages: window }))} />
          </div>
        ))}
        {tasks.data && <ListPager name="tasks" page={tasks.data} onWindow={setTaskPage} />}
        {isRevealed && drill && <CompositeDrilldown runId={runId} drilldownKey={drill.key} label={drill.label} onClose={() => setDrill(null)} onOpenItem={onOpenItem} />}
      </section>

      {GRADING_STAGES.map((stage) => <StageFindings key={stage} runId={runId} stage={stage} onOpenItem={onOpenItem} onOpenTask={onOpenTask} />)}

      {(unresolved.data?.total ?? 0) > 0 && (
        <section className="flex flex-col gap-1" data-testid="or-grading-unresolved">
          <h3 className="m-0 text-sm font-semibold text-[var(--text-primary)]">Unresolved task references ({unresolved.data?.total})</h3>
          <ul className="m-0 list-none divide-y divide-[var(--border-subtle)] p-0">
            {unresolved.data?.items.map((reference) => (
              <li key={reference.relation_id} className="flex items-start gap-2 py-1.5" data-testid="or-grading-unresolved-reference">
                <code className="or-code shrink-0">{reference.unresolved_target_ref}</code>
                <p className="m-0 min-w-0 flex-1 text-sm text-[var(--text-secondary)]">{selectItemText(reference.item.selected_value)}</p>
                <GradeItemButton selection={{ source_revision_id: reference.item.source_revision_id, item_path: reference.item.item_path }} onOpenItem={onOpenItem} />
              </li>
            ))}
          </ul>
          {unresolved.data && <ListPager name="unresolved" page={unresolved.data} onWindow={setUnresolvedPage} />}
        </section>
      )}
    </article>
  );
}
