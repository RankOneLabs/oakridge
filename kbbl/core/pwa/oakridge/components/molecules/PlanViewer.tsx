import { useMemo, useState } from "react";
import type { ViewerProps } from "../../artifactRegistry";
import { parsePlan, selectOrderedCohorts, type PlanScope } from "../../lib/plan";
import { selectPlanGraphLayout } from "../../lib/plan-graph";
import type { ArtifactReviewDescriptor, CohortId } from "../../types";
import { ArtifactSection, artifactLabelClass } from "./ArtifactSection";
import { PlanCohortCard } from "./PlanCohortCard";
import { PlanGraph } from "./PlanGraph";
import { RiskCard } from "./RiskCard";

type PlanSection = "summary" | "scope" | "cohorts" | "risks" | "acceptance_criteria";

/** A descriptor with no sections shows them all. */
function isSectionVisible(descriptor: ArtifactReviewDescriptor | null | undefined, section: PlanSection): boolean {
  const sections = descriptor?.sections ?? [];
  return sections.length === 0 || sections.includes(section);
}

function ScopeColumns({ scope }: { scope: PlanScope }) {
  const columns = [{ label: "In scope", values: scope.in_scope }, { label: "Out of scope", values: scope.out_of_scope }];
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {columns.map(({ label, values }) => (
        <div key={label} className="rounded-md border border-[var(--border-subtle)] px-3 py-2">
          <div className={artifactLabelClass}>{label} ({values.length})</div>
          {values.length > 0 ? (
            <ul className="m-0 mt-1 list-disc space-y-1 pl-5 text-sm text-[var(--text-secondary)]">
              {values.map((value, index) => <li key={`${index}-${value}`}>{value}</li>)}
            </ul>
          ) : <p className="mt-1 text-sm text-[var(--text-muted)]">None listed.</p>}
        </div>
      ))}
    </div>
  );
}

export function PlanViewer({ body, descriptor }: ViewerProps) {
  const [selectedCohortId, setSelectedCohortId] = useState<CohortId | null>(null);
  const parsed = useMemo(() => parsePlan(body), [body]);
  const layout = useMemo(() => parsed.ok ? selectPlanGraphLayout(parsed.value.cohorts) : null, [parsed]);

  if (!parsed.ok || !layout) {
    const detail = parsed.ok ? "" : ` (${parsed.error.field}: ${parsed.error.detail})`;
    return <div className="or-error" role="alert">This plan does not match the registered contract{detail}.</div>;
  }
  const plan = parsed.value;
  const cohorts = selectOrderedCohorts(plan);

  return (
    <article className="flex flex-col gap-5" data-testid="or-plan-viewer">
      {isSectionVisible(descriptor, "summary") && (
        <p className="text-sm leading-relaxed text-[var(--text-primary)]">{plan.summary}</p>
      )}

      {isSectionVisible(descriptor, "cohorts") && cohorts.length > 0 && (
        <ArtifactSection title={`Cohort graph (${cohorts.length})`} testId="or-plan-graph-section">
          <PlanGraph layout={layout} selectedCohortId={selectedCohortId} onSelectCohort={setSelectedCohortId} />
        </ArtifactSection>
      )}

      {isSectionVisible(descriptor, "risks") && (
        <ArtifactSection title={`Risks (${plan.risks.length})`} testId="or-plan-risks">
          {plan.risks.length > 0
            ? plan.risks.map((risk, index) => <RiskCard key={`${index}-${risk.description}`} description={risk.description} mitigation={risk.mitigation} />)
            : <p className="text-sm text-[var(--text-muted)]">No risks identified.</p>}
        </ArtifactSection>
      )}

      {isSectionVisible(descriptor, "cohorts") && cohorts.length > 0 && (
        <ArtifactSection title="Cohorts, in dependency order" testId="or-plan-cohorts">
          <ol className="m-0 flex list-none flex-col gap-2 p-0">
            {cohorts.map((cohort, index) => (
              <PlanCohortCard key={cohort.id} cohort={cohort} order={index + 1} isSelected={cohort.id === selectedCohortId} onSelectCohort={setSelectedCohortId} />
            ))}
          </ol>
        </ArtifactSection>
      )}

      {isSectionVisible(descriptor, "scope") && (
        <ArtifactSection title="Scope" testId="or-plan-scope">
          <ScopeColumns scope={plan.scope} />
        </ArtifactSection>
      )}

      {isSectionVisible(descriptor, "acceptance_criteria") && plan.acceptance_criteria.length > 0 && (
        <ArtifactSection title={`Acceptance criteria (${plan.acceptance_criteria.length})`} testId="or-plan-acceptance">
          <ol className="m-0 list-decimal space-y-1 pl-5 text-sm text-[var(--text-secondary)]">
            {plan.acceptance_criteria.map((criterion, index) => <li key={`${index}-${criterion}`}>{criterion}</li>)}
          </ol>
        </ArtifactSection>
      )}
    </article>
  );
}
