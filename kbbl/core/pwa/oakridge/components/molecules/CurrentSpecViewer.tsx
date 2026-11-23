import type { MouseEvent } from "react";
import { artifactRevisionIdOf } from "../../lib/grading-ids";
import type { ViewerProps } from "../../artifactRegistry";
import { parseCanonicalSpec, type CanonicalRequirement, type CanonicalSpec } from "../../lib/viewer-data";
import { selectRequirementFindings, type FindingReference } from "../../lib/current-analysis";
import { selectSpecSections, type SpecSection } from "../../lib/current-spec";
import { selectStatusTone } from "../../lib/status-tone";
import { selectFindingSelections } from "../../lib/grading";
import { selectSpecItemPaths } from "../../lib/current-item-paths";
import { Chip } from "../../../components/atoms/Chip";
import { artifactLabelClass } from "./ArtifactSection";
import { ArtifactItemGrade } from "./ArtifactItemGrade";
import { ArtifactSectionTabs } from "./ArtifactSectionTabs";
import { navigateArtifactAnchor, CurrentParseFailure, OriginalInput, selectOriginalSpec, SourceReferences } from "./CurrentArtifactParts";

function AnalysisFindingLink({ id, reference, props }: { id: string; reference: FindingReference; props: ViewerProps }) {
  const openFinding = (event: MouseEvent<HTMLAnchorElement>) => {
    if (props.onOpenItem && props.context?.analysis_revision_id) {
      event.preventDefault();
      props.onOpenItem({ source_revision_id: artifactRevisionIdOf(props.context.analysis_revision_id), item_path: reference.path });
    } else navigateArtifactAnchor(event, `analysis-finding-${id}`);
  };
  const resolution = reference.finding.resolution;
  return <div className="space-y-1">
    <div className="flex flex-wrap items-center gap-2">
      <a className="underline" href={`#analysis-finding-${id}`} onClick={openFinding}><code className="or-code">{id}</code></a>
      <Chip tone={selectStatusTone(reference.finding.severity)}>{reference.finding.severity}</Chip>
      {resolution && <Chip tone="neutral">{resolution.kind}</Chip>}
      {resolution?.chosen && <Chip tone="success">Chosen: {resolution.chosen}</Chip>}
    </div>
    <details id={`analysis-finding-${id}`}><summary>{reference.requirement_id}/{id}</summary>
      <p>{reference.finding.observation}</p>{resolution && <p>{resolution.text}</p>}
    </details>
  </div>;
}

function RequirementCard({ requirement, index, props, onOpenOriginalInput }: { requirement: CanonicalRequirement; index: number; props: ViewerProps; onOpenOriginalInput: () => void }) {
  const findings = selectRequirementFindings(requirement, props.context?.analysis ?? null);
  return <section id={`requirement-${requirement.id}`} className="space-y-2 rounded border border-[var(--border-muted)] p-3" data-testid="or-spec-requirement">
    <div className="flex flex-wrap items-center gap-2">
      <code className="or-code">{requirement.id}</code>
      <span className="ml-auto"><ArtifactItemGrade source={props.source} itemPath={`/requirements/${index}`} onOpenItem={props.onOpenItem} itemGrading={props.itemGrading} /></span>
    </div>
    <p>{requirement.text}</p>
    <div className={artifactLabelClass}>Acceptance conditions</div>
    <ul>{requirement.acceptance_conditions.map((condition, conditionIndex) => <li key={conditionIndex}>{condition}</li>)}</ul>
    <SourceReferences refs={requirement.source_refs} onOpenOriginalInput={onOpenOriginalInput} />
    {findings.length > 0 && <>
      <div className={artifactLabelClass}>Approved transformations and operator decisions</div>
      {findings.map(({ id, reference }) => reference
        ? <AnalysisFindingLink key={id} id={id} reference={reference} props={props} />
        : <div key={id} className="flex items-center gap-2"><code className="or-code">{id}</code><Chip tone="warning">unresolved analysis finding</Chip></div>)}
    </>}
  </section>;
}

function NonGoalsPanel({ spec }: { spec: CanonicalSpec }) {
  if (spec.non_goals.length === 0) return <p className="text-sm text-[var(--text-muted)]">No non-goals.</p>;
  return <ul className="list-disc pl-5">{spec.non_goals.map((goal, index) => <li key={index}>{goal}</li>)}</ul>;
}

export function CurrentSpecViewer(props: ViewerProps) {
  const parsed = parseCanonicalSpec(props.body);
  if (!parsed.ok) return <CurrentParseFailure body={props.body} detail={parsed.error.detail} />;
  const spec = parsed.value;
  return <article className="space-y-4" data-testid="or-current-spec-viewer">
    <header className="space-y-2">
      <div className={artifactLabelClass}>Objective</div>
      <p>{spec.objective}</p>
      {props.itemGrading?.renderShowAll(selectFindingSelections(props.source, selectSpecItemPaths(spec)))}
    </header>
    <ArtifactSectionTabs<SpecSection> label="Specification sections" sections={selectSpecSections(spec)} initial="requirements">{(section) => ({
      requirements: <div className="space-y-3">{spec.requirements.map((requirement, index) =>
        <RequirementCard key={requirement.id} requirement={requirement} index={index} props={props} onOpenOriginalInput={() => section.openAnchor("original_input", "original-input")} />)}</div>,
      non_goals: <NonGoalsPanel spec={spec} />,
      original_input: <OriginalInput text={selectOriginalSpec(props.source?.producing_attempt_inputs)} />,
    })}</ArtifactSectionTabs>
  </article>;
}
