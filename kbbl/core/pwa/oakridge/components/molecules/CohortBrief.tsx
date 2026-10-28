import type { StageUnit } from "../../types";
import { selectCohortBrief } from "../../lib/stage-unit-params";
import { isBuildBriefIdLinked, type BuildBrief } from "../../lib/build-brief";
import { planCriterionText, type PlanCriterion } from "../../lib/plan";

interface CohortBriefProps {
  unit: StageUnit;
}

function TextList({ label, values }: { label: string; values?: string[] }) {
  if (!values?.length) return null;
  return (
    <div>
      <h5 className="mb-1 mt-0 text-xs font-semibold uppercase text-[var(--text-muted)]">{label}</h5>
      <ul className="m-0 space-y-1 pl-5 text-sm text-[var(--text-secondary)]">
        {values.map((value) => <li key={value}>{value}</li>)}
      </ul>
    </div>
  );
}

function DecisionList({ decisions }: { decisions: BuildBrief["decisions_made"] }) {
  if (!decisions.length) return null;
  return (
    <div>
      <h5 className="mb-1 mt-0 text-xs font-semibold uppercase text-[var(--text-muted)]">Decisions</h5>
      <ul className="m-0 space-y-1 pl-5 text-sm text-[var(--text-secondary)]">
        {decisions.map((item, index) => (
          <li key={`${index}-${item.decision}`}>
            {item.id && <code className="or-code mr-2">{item.id}</code>}
            {item.decision}
            {item.rationale && (
              <span className="block text-xs text-[var(--text-muted)]">{item.rationale}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function RejectedList({ approaches }: { approaches: BuildBrief["approaches_rejected"] }) {
  if (!approaches.length) return null;
  return (
    <div>
      <h5 className="mb-1 mt-0 text-xs font-semibold uppercase text-[var(--text-muted)]">Approaches rejected</h5>
      <ul className="m-0 space-y-1 pl-5 text-sm text-[var(--text-secondary)]">
        {approaches.map((item, index) => <li key={index}>
          {item.id && <code className="or-code mr-2">{item.id}</code>}
          {item.approach}
          <span className="block text-xs text-[var(--text-muted)]">{item.reason}</span>
          {"decision_ids" in item && item.decision_ids.length > 0 && <span className="block text-xs text-[var(--text-muted)]">Decisions: {item.decision_ids.map((id) => <code key={id} className="or-code mr-1">{id}</code>)}</span>}
        </li>)}
      </ul>
    </div>
  );
}

function CriterionList({ criteria }: { criteria: PlanCriterion[] }) {
  if (!criteria.length) return null;
  return (
    <div>
      <h5 className="mb-1 mt-0 text-xs font-semibold uppercase text-[var(--text-muted)]">Acceptance criteria</h5>
      <ul className="m-0 space-y-1 pl-5 text-sm text-[var(--text-secondary)]">
        {criteria.map((criterion, index) => <li key={index}>
          {typeof criterion !== "string" && <code className="or-code mr-2">{criterion.id}</code>}
          {planCriterionText(criterion)}
          {typeof criterion !== "string" && (criterion.task_ids.length > 0 || criterion.decision_ids.length > 0) && <span className="block text-xs text-[var(--text-muted)]">
            {criterion.task_ids.length > 0 && <>Tasks: {criterion.task_ids.map((id) => <code key={id} className="or-code mr-1">{id}</code>)}</>}
            {criterion.decision_ids.length > 0 && <>Decisions: {criterion.decision_ids.map((id) => <code key={id} className="or-code mr-1">{id}</code>)}</>}
          </span>}
        </li>)}
      </ul>
    </div>
  );
}

export function CohortBrief({ unit }: CohortBriefProps) {
  const brief = selectCohortBrief(unit);
  if (!brief) return null;

  return (
    <article className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-4" data-testid="or-cohort-brief">
      <div className="mb-3 flex flex-wrap items-baseline gap-2">
        <h4 className="m-0 text-sm font-semibold text-[var(--text-primary)]">{brief.title}</h4>
        <span className="rounded border border-[var(--border-muted)] px-1.5 py-0.5 text-xs text-[var(--text-secondary)]">
          {brief.repository_key}
        </span>
        {!isBuildBriefIdLinked(brief) && <span className="text-xs text-[var(--text-muted)]">Not id-linked</span>}
      </div>
      {brief.goal && <p className="mb-2 mt-0 text-sm font-medium text-[var(--text-primary)]">{brief.goal}</p>}
      {brief.next_action && <p className="mb-3 mt-0 whitespace-pre-wrap text-sm text-[var(--text-secondary)]">{brief.next_action}</p>}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <TextList label="Files in scope" values={brief.files_in_scope} />
        <DecisionList decisions={brief.decisions_made} />
        <RejectedList approaches={brief.approaches_rejected} />
        <CriterionList criteria={brief.acceptance_criteria} />
        <TextList label="Depends on" values={brief.depends_on} />
      </div>
    </article>
  );
}
