import { useMemo, useState } from "react";
import type { ViewerProps } from "../../artifactRegistry";
import { parseCurrentPlan } from "../../lib/plan";
import { selectParallelCohortRows, selectPlanGraphLayout, type ParallelCohortRow } from "../../lib/plan-graph";
import { selectPlanSections, type PlanSection } from "../../lib/current-plan";
import type { CurrentCohort } from "../../lib/viewer-data";
import { selectAllocations } from "../../lib/current-brief";
import { selectFindingSelections } from "../../lib/grading";
import { selectPlanItemPaths } from "../../lib/current-item-paths";
import { Chip } from "../../../components/atoms/Chip";
import { artifactLabelClass } from "./ArtifactSection";
import { ArtifactItemGrade } from "./ArtifactItemGrade";
import { ArtifactSectionTabs } from "./ArtifactSectionTabs";
import { PlanGraph } from "./PlanGraph";
import { navigateArtifactAnchor, CurrentParseFailure, RequirementLink } from "./CurrentArtifactParts";

interface CohortCardProps { row: ParallelCohortRow; isSelected: boolean; props: ViewerProps }

function CohortCard({ row: { cohort, cohort_index: cohortIndex, wave_number }, isSelected, props }: CohortCardProps) {
  return <section id={`cohort-${cohort.id}`} data-testid="or-plan-cohort"
    className={`space-y-2 rounded border p-3 ${isSelected ? "border-[var(--accent-primary)] ring-1 ring-[var(--accent-primary)]" : "border-[var(--border-muted)]"}`}>
    <div className="flex flex-wrap items-center gap-2">
      <code className="or-code">{cohort.id}</code>
      {wave_number !== null && <Chip tone="info">Parallel wave {wave_number}</Chip>}
      <Chip tone="muted">{cohort.repository_key}</Chip>
    </div>
    <p className="font-medium">{cohort.title}</p>
    <div className={artifactLabelClass}>Scope</div>
    <p className="text-sm text-[var(--text-secondary)]">{cohort.change_scope ?? cohort.scope}</p>
    <div className={artifactLabelClass}>Allocations</div>
    <ul className="space-y-2">{selectAllocations(cohort, props.context?.spec ?? null).map((allocation, index) => <li key={allocation.requirement_id} className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <RequirementLink id={allocation.requirement_id} requirements={props.context?.requirements ?? []} onOpenTask={props.onOpenTask} />
        <span className="ml-auto"><ArtifactItemGrade source={props.source} itemPath={`/cohorts/${cohortIndex}/allocations/${index}`} onOpenItem={props.onOpenItem} itemGrading={props.itemGrading} /></span>
      </div>
      <p className="text-sm text-[var(--text-secondary)]">{allocation.contribution}</p>
    </li>)}</ul>
    {cohort.depends_on.length > 0 && <>
      <div className={artifactLabelClass}>Depends on</div>
      <div className="flex flex-wrap gap-2">{cohort.depends_on.map((id) => <a key={id} className="underline" href={`#cohort-${id}`} onClick={(event) => navigateArtifactAnchor(event, `cohort-${id}`)}><code>{id}</code></a>)}</div>
    </>}
    <div className={artifactLabelClass}>Rationale</div>
    <p className="text-sm text-[var(--text-secondary)]">{cohort.rationale}</p>
  </section>;
}

export function CurrentPlanViewer(props: ViewerProps) {
  const [selectedCohortId, setSelectedCohortId] = useState<CurrentCohort["id"] | null>(null);
  const parsed = parseCurrentPlan(props.body);
  const cohorts = parsed.ok ? parsed.value.cohorts : null;
  const layout = useMemo(() => cohorts ? selectPlanGraphLayout(cohorts) : null, [cohorts]);
  if (!parsed.ok) return <CurrentParseFailure body={props.body} detail={parsed.error.detail} />;
  const waves = selectParallelCohortRows(parsed.value);
  return <article className="space-y-4" data-testid="or-current-plan-viewer">
    <header className="space-y-2">
      {props.itemGrading?.renderShowAll(selectFindingSelections(props.source, selectPlanItemPaths(parsed.value)))}
      {waves.error && <p role="alert">Cannot order cohorts: {waves.error.kind}: {waves.error.cohort_ids.join(", ")}</p>}
    </header>
    <ArtifactSectionTabs<PlanSection> label="Plan sections" sections={selectPlanSections(parsed.value)} initial="graph">{(section) => ({
      graph: layout && <div data-testid="or-plan-graph-section">
        {/* Selecting a cohort in the graph opens its card, as the legacy plan card does. */}
        <PlanGraph layout={layout} selectedCohortId={selectedCohortId} onSelectCohort={(id) => { setSelectedCohortId(id); section.openAnchor("cohorts", `cohort-${id}`); }} />
      </div>,
      cohorts: <div className="space-y-3">{waves.rows.map((row) =>
        <CohortCard key={row.cohort.id} row={row} isSelected={row.cohort.id === selectedCohortId} props={props} />)}</div>,
    })}</ArtifactSectionTabs>
  </article>;
}
