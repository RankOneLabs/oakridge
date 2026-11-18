import type { ViewerProps } from "../../artifactRegistry";
import { parseCurrentPlan } from "../../lib/plan";
import { selectParallelWaves } from "../../lib/plan-graph";
import { selectAllocations } from "../../lib/current-brief";
import { navigateArtifactAnchor, CurrentParseFailure, RequirementLink } from "./CurrentArtifactParts";
import { ArtifactItemGrade } from "./ArtifactItemGrade";
export function CurrentPlanViewer(props: ViewerProps) {
  const parsed = props.currentRead?.ok === false ? props.currentRead
    : props.currentRead?.value?.kind === "plan" ? { ok: true as const, value: props.currentRead.value.body } : parseCurrentPlan(props.body);
  if (!parsed.ok) return <CurrentParseFailure body={props.body} detail={parsed.error.detail} />;
  const waves = selectParallelWaves(parsed.value);
  return <article className="space-y-4">
    {!waves.ok && <p role="alert">Cannot order cohorts: {waves.error.kind}: {waves.error.cohort_ids.join(", ")}</p>}
    {parsed.value.cohorts.map((cohort, cohortIndex) => <section key={cohort.id} id={`cohort-${cohort.id}`} className="space-y-2 rounded border border-[var(--border-muted)] p-3">
      <h3>{cohort.id}: {cohort.title}</h3><p>Repository: {cohort.repository_key}</p><p>Scope: {cohort.scope}</p>
      {waves.ok && <p>Parallel wave {waves.value.findIndex((wave) => wave.some((entry) => entry.id === cohort.id)) + 1}</p>}
      <h4>Allocations</h4><ul>{selectAllocations(cohort, props.context?.spec ?? null).map((allocation, index) => <li key={allocation.requirement_id}>
        <RequirementLink id={allocation.requirement_id} requirements={props.context?.requirements ?? []} onOpenTask={props.onOpenTask} /><p>{allocation.contribution}</p>
        <ArtifactItemGrade source={props.source} itemPath={`/cohorts/${cohortIndex}/allocations/${index}`} onOpenItem={props.onOpenItem} itemGrading={props.itemGrading} />
      </li>)}</ul><h4>Dependencies</h4><ul>{cohort.depends_on.map((id) => <li key={id}><a href={`#cohort-${id}`} onClick={(event) => navigateArtifactAnchor(event, `cohort-${id}`)}>{id} → {cohort.id}</a></li>)}</ul><h4>Rationale</h4><p>{cohort.rationale}</p>
    </section>)}
  </article>;
}
