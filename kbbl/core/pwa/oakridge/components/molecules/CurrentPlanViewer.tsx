import { useMemo, useState } from "react";
import type { ViewerProps } from "../../artifactRegistry";
import { parseCurrentPlan } from "../../lib/plan";
import { selectParallelCohortRows, selectPlanGraphLayout } from "../../lib/plan-graph";
import type { CurrentCohort } from "../../lib/current-contract";
import { ArtifactSection } from "./ArtifactSection";
import { PlanGraph } from "./PlanGraph";
import { selectAllocations } from "../../lib/current-brief";
import { navigateArtifactAnchor, CurrentParseFailure, RequirementLink } from "./CurrentArtifactParts";
import { ArtifactItemGrade } from "./ArtifactItemGrade";
import { selectFindingSelections } from "../../lib/grading";
import { selectPlanItemPaths } from "../../lib/current-item-paths";
export function CurrentPlanViewer(props: ViewerProps) {
  const [selectedCohortId, setSelectedCohortId] = useState<CurrentCohort["id"] | null>(null);
  const parsed = props.currentRead?.ok === false ? props.currentRead
    : props.currentRead?.value?.kind === "plan" ? { ok: true as const, value: props.currentRead.value.body } : parseCurrentPlan(props.body);
  const cohorts = parsed.ok ? parsed.value.cohorts : null;
  const layout = useMemo(() => cohorts ? selectPlanGraphLayout(cohorts) : null, [cohorts]);
  if (!parsed.ok) return <CurrentParseFailure body={props.body} detail={parsed.error.detail} />;
  const waves = selectParallelCohortRows(parsed.value);
  return <article className="space-y-4">
    {props.itemGrading?.renderShowAll(selectFindingSelections(props.source, selectPlanItemPaths(parsed.value)))}
    {layout && layout.nodes.length > 0 && <ArtifactSection title={`Cohort graph (${layout.nodes.length})`} testId="or-plan-graph-section">
      <PlanGraph layout={layout} selectedCohortId={selectedCohortId} onSelectCohort={setSelectedCohortId} />
    </ArtifactSection>}
    {waves.error && <p role="alert">Cannot order cohorts: {waves.error.kind}: {waves.error.cohort_ids.join(", ")}</p>}
    {waves.rows.map(({ cohort, cohort_index: cohortIndex, wave_number }) => <section key={cohort.id} id={`cohort-${cohort.id}`} className={`space-y-2 rounded border p-3 ${cohort.id === selectedCohortId ? "border-[var(--accent-primary)] ring-1 ring-[var(--accent-primary)]" : "border-[var(--border-muted)]"}`}>
      <h3>{cohort.id}: {cohort.title}</h3><p>Repository: {cohort.repository_key}</p><p>Scope: {cohort.scope}</p>
      {wave_number !== null && <p>Parallel wave {wave_number}</p>}
      <h4>Allocations</h4><ul>{selectAllocations(cohort, props.context?.spec ?? null).map((allocation, index) => <li key={allocation.requirement_id}>
        <RequirementLink id={allocation.requirement_id} requirements={props.context?.requirements ?? []} onOpenTask={props.onOpenTask} /><p>{allocation.contribution}</p>
        <ArtifactItemGrade source={props.source} itemPath={`/cohorts/${cohortIndex}/allocations/${index}`} onOpenItem={props.onOpenItem} itemGrading={props.itemGrading} />
      </li>)}</ul><h4>Dependencies</h4><ul>{cohort.depends_on.map((id) => <li key={id}><a href={`#cohort-${id}`} onClick={(event) => navigateArtifactAnchor(event, `cohort-${id}`)}>{id} → {cohort.id}</a></li>)}</ul><h4>Rationale</h4><p>{cohort.rationale}</p>
    </section>)}
  </article>;
}
