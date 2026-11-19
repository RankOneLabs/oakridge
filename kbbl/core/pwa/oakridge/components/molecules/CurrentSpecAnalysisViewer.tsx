import type { MouseEvent } from "react";
import type { ViewerProps } from "../../artifactRegistry";
import { parseCurrentAnalysis } from "../../lib/spec-analysis";
import { selectAnalysisCounts, selectAnalysisSections, selectCodeHotspots, selectOperatorDecisions, selectRequirementsByStatus, type AnalysisSection, type FindingReference } from "../../lib/current-analysis";
import type { CurrentAnalysis, CurrentFinding } from "../../lib/current-contract";
import { selectCurrentRequirementTone, selectStatusTone } from "../../lib/status-tone";
import { selectFindingSelections } from "../../lib/grading";
import { selectAnalysisItemPaths } from "../../lib/current-item-paths";
import { Chip } from "../../../components/atoms/Chip";
import { artifactLabelClass } from "./ArtifactSection";
import { ArtifactItemGrade } from "./ArtifactItemGrade";
import { ArtifactSectionTabs } from "./ArtifactSectionTabs";
import { CurrentParseFailure, OriginalInput, SourceReferences } from "./CurrentArtifactParts";

type GradeSlots = Pick<ViewerProps, "source" | "onOpenItem" | "itemGrading">;
type OpenFinding = (event: MouseEvent<HTMLAnchorElement>, reference: FindingReference) => void;

function AnalysisCounts({ analysis }: { analysis: CurrentAnalysis }) {
  const counts = selectAnalysisCounts(analysis);
  return <div className="flex flex-col gap-1.5">
    <div className="flex flex-wrap items-center gap-1.5" data-testid="or-analysis-requirement-counts">
      <span className={artifactLabelClass}>Requirements</span>
      {counts.requirements.map(({ status, count }) => <Chip key={status} tone={selectCurrentRequirementTone(status)}>{count} {status}</Chip>)}
    </div>
    <div className="flex flex-wrap items-center gap-1.5" data-testid="or-analysis-finding-counts">
      <span className={artifactLabelClass}>Findings</span>
      {counts.findings.map(({ severity, count }) => <Chip key={severity} tone={selectStatusTone(severity)}>{count} {severity}</Chip>)}
    </div>
  </div>;
}

function FindingCard({ finding, itemPath, grading }: { finding: CurrentFinding; itemPath: string; grading: GradeSlots }) {
  const resolution = finding.resolution;
  return <section id={`finding-${finding.id}`} className="ml-3 space-y-2 border-l border-[var(--border-muted)] pl-3" data-testid="or-analysis-finding">
    <div className="flex flex-wrap items-center gap-2">
      <code className="or-code">{finding.id}</code>
      <Chip tone={selectStatusTone(finding.severity)}>{finding.severity}</Chip>
      {resolution && <Chip tone="neutral">{resolution.kind}</Chip>}
      <span className="ml-auto"><ArtifactItemGrade source={grading.source} itemPath={itemPath} onOpenItem={grading.onOpenItem} itemGrading={grading.itemGrading} /></span>
    </div>
    <p className="text-sm text-[var(--text-secondary)]">{finding.observation}</p>
    <div className={artifactLabelClass}>Evidence</div>
    <ul>{finding.evidence.map((entry, index) => <li key={index}><Chip tone="muted">{entry.kind}</Chip> <code>{entry.ref}</code> — {entry.detail}</li>)}</ul>
    <div className={artifactLabelClass}>Anticipated change locations</div>
    <ul>{finding.expected_change_locations.map((entry, index) => <li key={index}><code>{entry.path}{entry.symbol ? ` · ${entry.symbol}` : ""}</code></li>)}</ul>
    {resolution && <div className="space-y-1">
      <div className={artifactLabelClass}>Resolution</div>
      <p>{resolution.text}</p>
      {resolution.question && <p>{resolution.question}</p>}
      <ul>{resolution.alternatives?.map((alternative, index) => <li key={index}>{alternative.option}: {alternative.consequence}</li>)}</ul>
      {resolution.kind === "operator_decision" && <ChosenOption chosen={resolution.chosen ?? null} />}
    </div>}
  </section>;
}

function ChosenOption({ chosen }: { chosen: string | null }) {
  return chosen ? <Chip tone="success">Chosen: {chosen}</Chip> : <Chip tone="warning">Undecided</Chip>;
}

function FindingLink({ reference, onOpenFinding, children }: { reference: FindingReference; onOpenFinding: OpenFinding; children: string }) {
  return <a className="mr-2 underline" href={`#finding-${reference.finding.id}`} onClick={(event) => onOpenFinding(event, reference)}>{children}</a>;
}

function RequirementsPanel({ analysis, grading, onOpenOriginalInput }: { analysis: CurrentAnalysis; grading: GradeSlots; onOpenOriginalInput: () => void }) {
  return <div className="space-y-3">
    {selectRequirementsByStatus(analysis).map(({ requirement, index, status }) => <section key={requirement.id} className="space-y-2 rounded border border-[var(--border-muted)] p-3" data-testid="or-analysis-requirement">
      <div className="flex flex-wrap items-center gap-2"><code className="or-code">{requirement.id}</code><Chip tone={selectCurrentRequirementTone(status)}>{status}</Chip></div>
      <p>{requirement.text}</p>
      <SourceReferences refs={requirement.source_refs} onOpenOriginalInput={onOpenOriginalInput} />
      {requirement.findings.map((finding, findingIndex) => <FindingCard key={finding.id} finding={finding} itemPath={`/requirements/${index}/findings/${findingIndex}`} grading={grading} />)}
    </section>)}
  </div>;
}

function HotspotsPanel({ analysis, onOpenFinding }: { analysis: CurrentAnalysis; onOpenFinding: OpenFinding }) {
  const hotspots = selectCodeHotspots(analysis);
  if (hotspots.length === 0) return <p className="text-sm text-[var(--text-muted)]">No code hotspots.</p>;
  return <ul className="space-y-1">{hotspots.map((hotspot) => <li key={hotspot.path}><code>{hotspot.path}</code>: {hotspot.references.map((reference) =>
    <FindingLink key={reference.finding.id} reference={reference} onOpenFinding={onOpenFinding}>{`${reference.requirement_id}/${reference.finding.id}`}</FindingLink>)}</li>)}</ul>;
}

function DecisionsPanel({ analysis, onOpenFinding }: { analysis: CurrentAnalysis; onOpenFinding: OpenFinding }) {
  const decisions = selectOperatorDecisions(analysis);
  if (decisions.length === 0) return <p className="text-sm text-[var(--text-muted)]">No operator decisions.</p>;
  return <div className="space-y-3">{decisions.map((entry) => <section key={entry.finding.id} className="space-y-1 rounded border border-[var(--border-muted)] p-3">
    <div className="flex flex-wrap items-center gap-2">
      <FindingLink reference={entry} onOpenFinding={onOpenFinding}>{entry.finding.id}</FindingLink>
      <Chip tone={selectStatusTone(entry.finding.severity)}>{entry.finding.severity}</Chip>
      <ChosenOption chosen={entry.finding.resolution?.chosen ?? null} />
    </div>
    <p>{entry.question}</p>
    <ul>{entry.alternatives.map((alternative, index) => <li key={index}>{alternative.option}: {alternative.consequence}</li>)}</ul>
  </section>)}</div>;
}

export function CurrentSpecAnalysisViewer(props: ViewerProps) {
  const parsed = props.currentRead?.ok === false ? props.currentRead
    : props.currentRead?.value?.kind === "analysis" ? { ok: true as const, value: props.currentRead.value.body } : parseCurrentAnalysis(props.body);
  if (!parsed.ok) return <CurrentParseFailure body={props.body} detail={parsed.error.detail} />;
  const analysis = parsed.value;
  return <article className="space-y-4" data-testid="or-current-analysis-viewer">
    <header className="space-y-2">
      <AnalysisCounts analysis={analysis} />
      {props.itemGrading?.renderShowAll(selectFindingSelections(props.source, selectAnalysisItemPaths(analysis)))}
    </header>
    <ArtifactSectionTabs<AnalysisSection> label="Analysis sections" sections={selectAnalysisSections(analysis)} initial="requirements">{(section) => {
      const onOpenFinding: OpenFinding = (event, reference) => { event.preventDefault(); section.openAnchor("requirements", `finding-${reference.finding.id}`); };
      return <>
        {section.active === "requirements" && <RequirementsPanel analysis={analysis} grading={props} onOpenOriginalInput={() => section.select("original_input")} />}
        {section.active === "hotspots" && <HotspotsPanel analysis={analysis} onOpenFinding={onOpenFinding} />}
        {section.active === "decisions" && <DecisionsPanel analysis={analysis} onOpenFinding={onOpenFinding} />}
        {section.active === "original_input" && <OriginalInput text={props.source?.original_spec} />}
      </>;
    }}</ArtifactSectionTabs>
  </article>;
}
