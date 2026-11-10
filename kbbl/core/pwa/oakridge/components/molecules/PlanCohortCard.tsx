import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../../../components/atoms/Button";
import { Chip } from "../../../components/atoms/Chip";
import type { PlanCohort } from "../../lib/plan";
import type { CohortId } from "../../run-types";
import { artifactLabelClass } from "./ArtifactSection";
import { ExpandableText } from "./ExpandableText";
import { TaskIdLink } from "./TaskIdLink";
import type { ViewerProps } from "../../artifactRegistry";
import { ArtifactItemGrade } from "./ArtifactItemGrade";

interface Props extends Pick<ViewerProps, "source" | "itemGrading" | "onOpenItem"> {
  cohort: PlanCohort;
  order: number;
  isSelected: boolean;
  onSelectCohort: (id: CohortId) => void;
  /** Opens one of this cohort's tasks. A task shared with another cohort opens the same task from both. */
  onOpenTask?: (task_id: string) => void;
  cohortIndex?: number;
}

/** The cohort's tasks by their run-scoped ids: the acceptance entries a plan assigns it. */
function CohortTasks({ cohort, onOpenTask, gradeAction, isOpen }: { cohort: PlanCohort; onOpenTask?: (task_id: string) => void; gradeAction: (index: number) => ReactNode; isOpen: boolean }) {
  if (cohort.acceptance_criteria.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5" data-testid="or-plan-cohort-tasks">
      <span className={artifactLabelClass}>Contributions to spec tasks</span>
      {cohort.acceptance_criteria.map(({ id, text }, index) => <div key={id} className="flex items-start gap-2">
        <TaskIdLink task_id={id} text={text} onOpenTask={onOpenTask} />
        {!isOpen && <span className="min-w-0 flex-1 text-sm text-[var(--text-secondary)]">{text}</span>}
        {gradeAction(index)}
      </div>)}
    </div>
  );
}

function DetailList({ label, values, isMono = false }: { label: string; values: string[]; isMono?: boolean }) {
  if (values.length === 0) return null;
  return (
    <div>
      <div className={artifactLabelClass}>{label}</div>
      <ul className={`m-0 mt-1 list-disc space-y-1 pl-5 text-[var(--text-secondary)] ${isMono ? "font-mono text-xs" : "text-sm"}`}>
        {values.map((value, index) => <li key={`${index}-${value}`}>{value}</li>)}
      </ul>
    </div>
  );
}

export function PlanCohortCard({ cohort, order, isSelected, onSelectCohort, onOpenTask, cohortIndex, source, itemGrading, onOpenItem }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const cardRef = useRef<HTMLLIElement>(null);

  // Selecting a cohort in the graph or from another card brings its card into view.
  useEffect(() => {
    if (isSelected) cardRef.current?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }, [isSelected]);

  return (
    <li
      ref={cardRef}
      className={`flex flex-col gap-1.5 rounded-md border bg-[var(--bg-surface)] px-3 py-2 ${isSelected ? "border-[var(--accent-blue)] ring-1 ring-[var(--accent-blue)]" : "border-[var(--border-subtle)]"}`}
      data-testid="or-plan-cohort"
      data-cohort-id={cohort.id}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-[var(--text-muted)]">{order}.</span>
        <code className="or-code">{cohort.id}</code>
        {cohort.repository_key && <Chip tone="neutral">{cohort.repository_key}</Chip>}
      </div>
      <p className="text-sm font-medium text-[var(--text-primary)]">{cohort.title}</p>
      {cohort.depends_on.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={artifactLabelClass}>After</span>
          {cohort.depends_on.map((id) => (
            <Button key={id} variant="secondary" size="xsmall" className="font-mono! text-xs!" onClick={() => onSelectCohort(id)}>{id}</Button>
          ))}
        </div>
      )}
      <CohortTasks cohort={cohort} isOpen={isOpen} onOpenTask={onOpenTask} gradeAction={(index) => cohortIndex === undefined ? null
        : <ArtifactItemGrade source={source} itemPath={`/cohorts/${cohortIndex}/acceptance_criteria/${index}`} itemGrading={itemGrading} onOpenItem={onOpenItem} />} />
      {cohort.description && <ExpandableText text={cohort.description} className="text-sm text-[var(--text-secondary)]" />}
      <Button variant="link" className="self-start text-xs! no-underline! hover:underline!" aria-expanded={isOpen} onClick={() => setIsOpen(!isOpen)}>
        {isOpen ? "Hide details" : `Details · ${cohort.files_in_scope.length} files · ${cohort.decisions.length} decisions · ${cohort.acceptance_criteria.length} ${cohort.acceptance_criteria.length === 1 ? "task" : "tasks"}`}
      </Button>
      {isOpen && (
        <div className="flex flex-col gap-3 border-t border-[var(--border-subtle)] pt-2" data-testid="or-plan-cohort-details">
          {cohort.scope && (
            <div>
              <div className={artifactLabelClass}>Scope</div>
              <p className="mt-1 text-sm text-[var(--text-secondary)]">{cohort.scope}</p>
            </div>
          )}
          <DetailList label="Files in scope" values={cohort.files_in_scope} isMono />
          {cohort.decisions.length > 0 && (
            <div>
              <div className={artifactLabelClass}>Decisions</div>
              <ul className="m-0 mt-1 list-disc space-y-1 pl-5 text-sm text-[var(--text-secondary)]">
                {cohort.decisions.map((decision, index) => <li key={index}>
                  <code className="or-code mr-2">{decision.id}</code>
                  {decision.text}
                </li>)}
              </ul>
            </div>
          )}
          {cohort.acceptance_criteria.length > 0 && (
            <div>
              <div className={artifactLabelClass}>Contributions to spec tasks</div>
              <ul className="m-0 mt-1 list-disc space-y-1 pl-5 text-sm text-[var(--text-secondary)]">
                {cohort.acceptance_criteria.map((criterion, index) => <li key={index}>
                  <code className="or-code mr-2">{criterion.id}</code>
                  {criterion.text}
                  {criterion.decision_ids.length > 0 && (
                    <span className="block text-xs text-[var(--text-muted)]">
                      Decisions: {criterion.decision_ids.map((id) => <code key={id} className="or-code mr-1">{id}</code>)}
                    </span>
                  )}
                </li>)}
              </ul>
            </div>
          )}
        </div>
      )}
    </li>
  );
}
