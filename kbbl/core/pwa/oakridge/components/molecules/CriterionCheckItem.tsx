import type { ReactNode } from "react";
import { Chip } from "../../../components/atoms/Chip";
import { selectCheckStatus, selectCheckText, type CriterionCheck } from "../../lib/assessment";
import { selectStatusTone } from "../../lib/status-tone";
import type { CriterionStatus } from "../../artifact-types";
import { artifactLabelClass } from "./ArtifactSection";
import { ExpandableText } from "./ExpandableText";

export const CRITERION_STATUS_LABEL: Record<CriterionStatus, string> = { met: "met", partial: "partial", not_met: "not met" };

function FindingDetail({ check, showBriefComparison }: { check: Extract<CriterionCheck, { kind: "finding" }>; showBriefComparison: boolean }) {
  const { finding, tasks, unresolved_task_ids } = check;
  const status = finding.status;
  const line = selectCheckText(check);
  return (
    <div className="flex flex-col gap-1 pl-8">
      {tasks.length > 0
        ? <span className="text-xs text-[var(--text-muted)]" data-testid="or-criterion-tasks">Tasks: {tasks.map((task) => <span key={task.id} className="mr-2"><code className="or-code">{task.id}</code>{task.number !== null && ` (${task.number})`}</span>)}</span>
        : showBriefComparison && <span className="text-xs text-[var(--text-muted)]">Linked to no task.</span>}
      {unresolved_task_ids.length > 0 && <span className="text-xs text-[var(--text-muted)]" data-testid="or-criterion-unresolved">Unresolved task IDs: {unresolved_task_ids.map((id) => <code key={id} className="or-code mr-1">{id}</code>)}</span>}
      <div className={artifactLabelClass}>Evidence</div>
      {finding.evidence.length === 0 ? (
        <span className="text-sm text-[var(--text-muted)]">{status === "met" ? "Met with no evidence cited." : "No evidence cited."}</span>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {finding.evidence.map((ref, index) => (
            <li key={`${index}-${ref.kind}-${ref.ref}`} className="text-sm text-[var(--text-secondary)]">
              <Chip tone="muted">{ref.kind}</Chip> <code className="or-code">{ref.ref}</code>
              {ref.detail && <span className="ml-2">{ref.detail}</span>}
            </li>
          ))}
        </ul>
      )}
      {finding.description !== null && finding.description !== line && <ExpandableText text={finding.description} className="text-sm text-[var(--text-secondary)]" />}
    </div>
  );
}

interface Props {
  check: CriterionCheck;
  showBriefComparison?: boolean;
  /** The finding's own grade control; a task no finding names has nothing to grade. */
  renderGradeAction?: (check: Extract<CriterionCheck, { kind: "finding" }>) => ReactNode;
}

/** One finding with the assessor's status and evidence, or one brief task no finding assessed. */
export function CriterionCheckItem({ check, showBriefComparison = true, renderGradeAction }: Props) {
  const status = selectCheckStatus(check);
  return (
    <li className="flex flex-col gap-1.5 py-2.5" data-testid="or-criterion-check" data-status={status ?? "unassessed"} data-kind={check.kind}>
      <div className="flex items-start gap-2">
        <span className="w-6 shrink-0 pt-0.5 text-right font-mono text-xs text-[var(--text-muted)]">{check.kind === "unassessed" ? `${check.number}.` : "–"}</span>
        <Chip tone={status ? selectStatusTone(status) : "muted"} className="shrink-0">{status ? CRITERION_STATUS_LABEL[status] : "not assessed"}</Chip>
        <p className="min-w-0 flex-1 text-sm font-medium text-[var(--text-primary)]">{selectCheckText(check)}</p>
        {check.kind === "finding" && renderGradeAction?.(check)}
      </div>
      {check.kind === "finding" && <FindingDetail check={check} showBriefComparison={showBriefComparison} />}
    </li>
  );
}
