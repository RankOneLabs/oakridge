import type { StageUnit } from "../../types";
import { selectCohortBrief } from "../../lib/stage-unit-params";
import type { BuildBrief } from "../../lib/build-brief";

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
      </div>
      {brief.goal && <p className="mb-2 mt-0 text-sm font-medium text-[var(--text-primary)]">{brief.goal}</p>}
      {brief.next_action && <p className="mb-3 mt-0 whitespace-pre-wrap text-sm text-[var(--text-secondary)]">{brief.next_action}</p>}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <TextList label="Files in scope" values={brief.files_in_scope} />
        <DecisionList decisions={brief.decisions_made} />
        <TextList label="Acceptance criteria" values={brief.acceptance_criteria} />
        <TextList label="Depends on" values={brief.depends_on} />
      </div>
    </article>
  );
}
