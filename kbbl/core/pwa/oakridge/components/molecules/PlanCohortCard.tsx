import { useEffect, useRef, useState } from "react";
import { Button } from "../../../components/atoms/Button";
import { Chip } from "../../../components/atoms/Chip";
import type { PlanCohort } from "../../lib/plan";
import type { CohortId } from "../../types";
import { artifactLabelClass } from "./ArtifactSection";
import { ExpandableText } from "./ExpandableText";

interface Props {
  cohort: PlanCohort;
  order: number;
  isSelected: boolean;
  onSelectCohort: (id: CohortId) => void;
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

export function PlanCohortCard({ cohort, order, isSelected, onSelectCohort }: Props) {
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
      {cohort.description && <ExpandableText text={cohort.description} className="text-sm text-[var(--text-secondary)]" />}
      <Button variant="link" className="self-start text-xs! no-underline! hover:underline!" aria-expanded={isOpen} onClick={() => setIsOpen(!isOpen)}>
        {isOpen ? "Hide details" : `Details · ${cohort.files_in_scope.length} files · ${cohort.decisions.length} decisions · ${cohort.acceptance_criteria.length} criteria`}
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
          <DetailList label="Decisions" values={cohort.decisions} />
          <DetailList label="Acceptance criteria" values={cohort.acceptance_criteria} />
        </div>
      )}
    </li>
  );
}
