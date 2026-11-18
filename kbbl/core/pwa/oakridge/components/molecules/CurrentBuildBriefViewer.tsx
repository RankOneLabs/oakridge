import type { ViewerProps } from "../../artifactRegistry";
import { parseCurrentBrief } from "../../lib/build-brief";
import { selectCurrentBuildItems } from "../../lib/current-brief";
import { CurrentParseFailure, RequirementLink } from "./CurrentArtifactParts";
import { ArtifactItemGrade } from "./ArtifactItemGrade";
import { selectFindingSelections } from "../../lib/grading";
import { selectBriefItemPaths } from "../../lib/current-item-paths";
export function CurrentBuildBriefViewer(props: ViewerProps) {
  const parsed = props.currentRead?.ok === false ? props.currentRead
    : props.currentRead?.value?.kind === "brief" ? { ok: true as const, value: props.currentRead.value.body } : parseCurrentBrief(props.body);
  if (!parsed.ok) return <CurrentParseFailure body={props.body} detail={parsed.error.detail} />;
  const brief = parsed.value;
  return <article className="space-y-5">
    {props.itemGrading?.renderShowAll(selectFindingSelections(props.source, selectBriefItemPaths(brief)))}
    <section className="rounded border-2 border-[var(--border-muted)] bg-[var(--bg-surface)] p-3"><h3>System-bound envelope</h3><p>Projected from the approved plan.</p><dl><dt>Cohort</dt><dd>{brief.cohort_id}</dd><dt>Repository</dt><dd>{brief.repository_key}</dd><dt>Dependencies</dt><dd>{brief.depends_on.join(", ") || "None"}</dd></dl></section>
    <section><h3>Author content: files in scope</h3><ul>{brief.files_in_scope.map((path, i) => <li key={i}><code>{path}</code></li>)}</ul></section>
    <section><h3>Author content: build items</h3>{selectCurrentBuildItems(brief).map((item, index) => <section key={item.id} className="space-y-2 rounded border border-[var(--border-muted)] p-3">
      <h4>{item.id}</h4><p>{item.instructions}</p><ArtifactItemGrade source={props.source} itemPath={`/build_items/${index}`} onOpenItem={props.onOpenItem} itemGrading={props.itemGrading} />
      <h5>Requirements</h5><ul>{item.requirement_ids.map((id) => <li key={id}><RequirementLink id={id} requirements={props.context?.requirements ?? []} onOpenTask={props.onOpenTask} /></li>)}</ul>
      <h5>Verification</h5><ul>{item.verification.map((step, i) => <li key={i}>{step}</li>)}</ul>
      <h5>Technical decisions</h5>{item.decisions.map((decision) => <div key={decision.id}><h6>{decision.id}: {decision.decision}</h6><p>{decision.rationale}</p></div>)}
    </section>)}</section>
  </article>;
}
