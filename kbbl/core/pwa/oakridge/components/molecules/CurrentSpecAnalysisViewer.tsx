import type { ViewerProps } from "../../artifactRegistry";
import { parseCurrentAnalysis } from "../../lib/spec-analysis";
import { requirementStatus, selectAnalysisCounts, selectCodeHotspots, selectOperatorDecisions } from "../../lib/current-analysis";
import { Chip } from "../../../components/atoms/Chip";
import { navigateArtifactAnchor, CurrentParseFailure, OriginalInput, SourceReferences } from "./CurrentArtifactParts";
import { ArtifactItemGrade } from "./ArtifactItemGrade";
export function CurrentSpecAnalysisViewer(props: ViewerProps) {
  const parsed = props.currentRead?.ok === false ? props.currentRead
    : props.currentRead?.value?.kind === "analysis" ? { ok: true as const, value: props.currentRead.value.body } : parseCurrentAnalysis(props.body);
  if (!parsed.ok) return <CurrentParseFailure body={props.body} detail={parsed.error.detail} />;
  const analysis = parsed.value, counts = selectAnalysisCounts(analysis);
  const hotspots = selectCodeHotspots(analysis), decisions = selectOperatorDecisions(analysis);
  return <article className="space-y-5">
    <header><h3>Requirements</h3><p>{counts.requirements.map(({ status, count }) => `${count} ${status}`).join(" · ")}</p>
      <h3>Findings</h3><p>{counts.findings.map(({ severity, count }) => `${count} ${severity}`).join(" · ")}</p></header>
    {analysis.requirements.map((requirement, i) => <section key={requirement.id} className="space-y-2 rounded border border-[var(--border-muted)] p-3">
      <h3><code>{requirement.id}</code> <Chip tone={requirementStatus(requirement) === "blocked" ? "danger" : "neutral"}>{requirementStatus(requirement)}</Chip></h3><p>{requirement.text}</p>
      <SourceReferences refs={requirement.source_refs} />
      {requirement.findings.map((finding, j) => <section id={`finding-${finding.id}`} key={finding.id} className="ml-3 border-l border-[var(--border-muted)] pl-3">
        <h4>{finding.id} · {finding.severity}</h4><ArtifactItemGrade source={props.source} itemPath={`/requirements/${i}/findings/${j}`} onOpenItem={props.onOpenItem} itemGrading={props.itemGrading} />
        <p>{finding.observation}</p><h5>Evidence</h5><ul>{finding.evidence.map((entry, index) => <li key={index}>{entry.kind}: <code>{entry.ref}</code> — {entry.detail}</li>)}</ul>
        <h5>Anticipated change locations</h5><ul>{finding.expected_change_locations.map((entry, index) => <li key={index}><code>{entry.path}{entry.symbol ? ` · ${entry.symbol}` : ""}</code></li>)}</ul>
        {finding.resolution && <div><h5>{finding.resolution.kind}</h5><p>{finding.resolution.text}</p>{finding.resolution.question && <p>{finding.resolution.question}</p>}
          <ul>{finding.resolution.alternatives?.map((alternative, index) => <li key={index}>{alternative.option}: {alternative.consequence}</li>)}</ul>
          {finding.resolution.kind === "operator_decision" && <p>Chosen: {finding.resolution.chosen ?? "undecided"}</p>}</div>}
      </section>)}
    </section>)}
    <section><h3>Code hotspots</h3>{hotspots.map((hotspot) => <p key={hotspot.path}><code>{hotspot.path}</code>: {hotspot.references.map((reference) => <a className="mr-2 underline" key={reference.finding.id} href={`#finding-${reference.finding.id}`} onClick={(event) => navigateArtifactAnchor(event, `finding-${reference.finding.id}`)}>{reference.requirement_id}/{reference.finding.id}</a>)}</p>)}</section>
    <section><h3>Operator decisions</h3>{decisions.map((entry) => <section key={entry.finding.id}><a href={`#finding-${entry.finding.id}`} onClick={(event) => navigateArtifactAnchor(event, `finding-${entry.finding.id}`)}>{entry.finding.id}</a><p>{entry.question}</p><ul>{entry.alternatives.map((alternative, index) => <li key={index}>{alternative.option}: {alternative.consequence}</li>)}</ul><p>Chosen: {entry.chosen}</p></section>)}</section>
    <OriginalInput text={props.source?.original_spec} />
  </article>;
}
