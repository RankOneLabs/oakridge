import { artifactRevisionIdOf } from "../../lib/grading-ids";
import type { ViewerProps } from "../../artifactRegistry";
import { parseCanonicalSpec } from "../../lib/current-contract";
import { selectRequirementFindings } from "../../lib/current-analysis";
import { navigateArtifactAnchor, CurrentParseFailure, OriginalInput, SourceReferences } from "./CurrentArtifactParts";
import { ArtifactItemGrade } from "./ArtifactItemGrade";
import { selectFindingSelections } from "../../lib/grading";
import { selectSpecItemPaths } from "../../lib/current-item-paths";
export function CurrentSpecViewer(props: ViewerProps) {
  const parsed = props.currentRead?.ok === false ? props.currentRead
    : props.currentRead?.value?.kind === "spec" ? { ok: true as const, value: props.currentRead.value.body } : parseCanonicalSpec(props.body);
  if (!parsed.ok) return <CurrentParseFailure body={props.body} detail={parsed.error.detail} />;
  return <article className="space-y-4"><h3>Objective</h3><p>{parsed.value.objective}</p>
    <OriginalInput text={props.source?.original_spec} />
    {props.itemGrading?.renderShowAll(selectFindingSelections(props.source, selectSpecItemPaths(parsed.value)))}
    {parsed.value.requirements.map((requirement, index) => <section key={requirement.id} id={`requirement-${requirement.id}`} className="rounded border border-[var(--border-muted)] p-3">
      <h3>{requirement.id}</h3><p>{requirement.text}</p><ArtifactItemGrade source={props.source} itemPath={`/requirements/${index}`} onOpenItem={props.onOpenItem} itemGrading={props.itemGrading} />
      <h4>Acceptance conditions</h4><ul>{requirement.acceptance_conditions.map((condition, i) => <li key={i}>{condition}</li>)}</ul><SourceReferences refs={requirement.source_refs} />
      <h4>Approved transformations and operator decisions</h4>
      {selectRequirementFindings(requirement, props.context?.analysis ?? null).map(({ id, reference }) => <div key={id}>
        {reference ? <><a href={`#analysis-finding-${id}`} onClick={(event) => {
          if (props.onOpenItem && props.context?.analysis_revision_id) {
            event.preventDefault();
            props.onOpenItem({ source_revision_id: artifactRevisionIdOf(props.context.analysis_revision_id), item_path: reference.path });
          } else navigateArtifactAnchor(event, `analysis-finding-${id}`);
        }}>{id} · {reference.finding.severity}</a><details id={`analysis-finding-${id}`}><summary>{reference.requirement_id}/{id}</summary><p>{reference.finding.observation}</p><p>{reference.finding.resolution?.kind}: {reference.finding.resolution?.text}</p><p>{reference.finding.resolution?.chosen}</p></details></> : <p>{id}: unresolved analysis finding</p>}
      </div>)}
    </section>)}
    <section><h3>Non-goals</h3><ul>{parsed.value.non_goals.map((goal, index) => <li key={index}>{goal}</li>)}</ul></section>
  </article>;
}
