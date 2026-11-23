import type { ViewerProps } from "../../artifactRegistry";
import { parseCurrentBrief, type CurrentBrief } from "../../lib/viewer-data";
import { selectBriefSections, selectCurrentBuildItems, type BriefSection } from "../../lib/current-brief";
import { selectFindingSelections } from "../../lib/grading";
import { selectBriefItemPaths } from "../../lib/current-item-paths";
import { Chip } from "../../../components/atoms/Chip";
import { artifactLabelClass } from "./ArtifactSection";
import { ArtifactItemGrade } from "./ArtifactItemGrade";
import { ArtifactSectionTabs } from "./ArtifactSectionTabs";
import { CurrentParseFailure, RequirementLink } from "./CurrentArtifactParts";

function BuildItemsPanel({ brief, props }: { brief: CurrentBrief; props: ViewerProps }) {
  return <div className="space-y-3">{selectCurrentBuildItems(brief).map((item, index) => <section key={item.id} className="space-y-2 rounded border border-[var(--border-muted)] p-3" data-testid="or-brief-build-item">
    <div className="flex flex-wrap items-center gap-2">
      <code className="or-code">{item.id}</code>
      <span className="ml-auto"><ArtifactItemGrade source={props.source} itemPath={`/build_items/${index}`} onOpenItem={props.onOpenItem} itemGrading={props.itemGrading} /></span>
    </div>
    <p>{item.instructions}</p>
    <div className={artifactLabelClass}>Requirements</div>
    <ul>{item.requirement_ids.map((id) => <li key={id}><RequirementLink id={id} requirements={props.context?.requirements ?? []} onOpenTask={props.onOpenTask} /></li>)}</ul>
    <div className={artifactLabelClass}>Verification</div>
    <ul className="list-disc pl-5">{item.verification.map((step, stepIndex) => <li key={stepIndex}>{step}</li>)}</ul>
    {item.decisions.length > 0 && <>
      <div className={artifactLabelClass}>Technical decisions</div>
      {item.decisions.map((decision) => <div key={decision.id} className="space-y-1">
        <div className="flex flex-wrap items-center gap-2"><code className="or-code">{decision.id}</code><span className="font-medium">{decision.decision}</span></div>
        <p className="text-sm text-[var(--text-secondary)]">{decision.decision_reason}</p>
      </div>)}
    </>}
  </section>)}</div>;
}

function FilesPanel({ brief }: { brief: CurrentBrief }) {
  if (brief.files_in_scope.length === 0) return <p className="text-sm text-[var(--text-muted)]">No files in scope.</p>;
  return <ul className="space-y-1">{brief.files_in_scope.map((path, index) => <li key={index}><code>{path}</code></li>)}</ul>;
}

function EnvelopePanel({ brief }: { brief: CurrentBrief }) {
  return <section className="space-y-2" data-testid="or-brief-envelope">
    <p className="text-sm text-[var(--text-muted)]">Projected from the approved plan.</p>
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
      <dt className={artifactLabelClass}>Cohort</dt><dd><code>{brief.cohort_id}</code></dd>
      <dt className={artifactLabelClass}>Repository</dt><dd><code>{brief.assigned_repository}</code></dd>
      <dt className={artifactLabelClass}>Dependencies</dt><dd>{brief.prerequisite_cohorts.length > 0 ? brief.prerequisite_cohorts.map((id) => <code key={id} className="mr-2">{id}</code>) : "None"}</dd>
    </dl>
  </section>;
}

export function CurrentBuildBriefViewer(props: ViewerProps) {
  const parsed = parseCurrentBrief(props.body);
  if (!parsed.ok) return <CurrentParseFailure body={props.body} detail={parsed.error.detail} />;
  const brief = parsed.value;
  return <article className="space-y-4" data-testid="or-current-brief-viewer">
    <header className="space-y-2">
      <div className="flex flex-wrap items-center gap-2"><span className={artifactLabelClass}>Cohort</span><code className="or-code">{brief.cohort_id}</code><Chip tone="muted">{brief.assigned_repository}</Chip></div>
      {props.itemGrading?.renderShowAll(selectFindingSelections(props.source, selectBriefItemPaths(brief)))}
    </header>
    <ArtifactSectionTabs<BriefSection> label="Brief sections" sections={selectBriefSections(brief)} initial="build_items">{() => ({
      build_items: <BuildItemsPanel brief={brief} props={props} />,
      files: <FilesPanel brief={brief} />,
      envelope: <EnvelopePanel brief={brief} />,
    })}</ArtifactSectionTabs>
  </article>;
}
