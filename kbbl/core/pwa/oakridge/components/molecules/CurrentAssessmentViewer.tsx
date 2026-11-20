import { useState, type ReactNode } from "react";
import { Chip } from "../../../components/atoms/Chip";
import { Select } from "../../../components/atoms/Select";
import { selectStatusTone } from "../../lib/status-tone";
import { selectFindingSelections } from "../../lib/grading";
import type { AssessmentVerdict } from "../../artifact-types";
import { ArtifactSection, artifactLabelClass } from "./ArtifactSection";
import { CRITERION_STATUS_LABEL } from "./CriterionCheckItem";
import { TestEvidenceBlock } from "./TestEvidenceBlock";
import { selectAdditionalFindings, selectAssessmentActions, selectAssessmentSections, selectDerivedVerdict, selectItemAssessmentGroups, type AssessmentItemLabel, type AssessmentSection, type AssessmentStatusFilter, type AttributedFinding, type CurrentAssessment } from "../../lib/current-assessment";
import { CurrentBuildItemAssessmentViewer } from "./BuildItemAssessmentViewer";
import { EvidenceRefList } from "./EvidenceRefList";
import { ArtifactItemGrade } from "./ArtifactItemGrade";
import { ArtifactSectionTabs } from "./ArtifactSectionTabs";
import { selectAssessmentItemPaths } from "../../lib/current-item-paths";
interface CurrentAssessmentProps extends Pick<import("../../artifactRegistry").ViewerProps, "source" | "itemGrading" | "onOpenItem"> {
  assessment: CurrentAssessment; itemLabels?: readonly AssessmentItemLabel[]; handoff?: ReactNode;
  /** The open review's decisions, shown above the sections so the operator never hunts for them. */
  decisionBar?: ReactNode;
  initialSection?: AssessmentSection;
}
const VERDICT_LABEL: Record<AssessmentVerdict, string> = { pass: "Pass", pass_with_notes: "Pass with notes", fail: "Fail" };
type AssessmentReviewSlots = Omit<CurrentAssessmentProps, "assessment" | "itemLabels" | "handoff" | "decisionBar" | "initialSection">;

function CurrentAssessmentHeader({ assessment, review }: { assessment: CurrentAssessment; review: AssessmentReviewSlots }) {
  const verdict = selectDerivedVerdict(assessment);
  return <header className="flex flex-col gap-2">
    <div className="flex flex-wrap items-center gap-2"><span className={artifactLabelClass}>Head</span><code className="or-code">{assessment.head_sha}</code>
      <span className={artifactLabelClass}>Derived verdict</span><Chip tone={selectStatusTone(verdict.verdict)}>{VERDICT_LABEL[verdict.verdict]}</Chip></div>
    {verdict.has_mismatch && <p role="alert">Authored verdict ({assessment.verdict}) disagrees with the item statuses and findings.</p>}
    <div className="flex flex-wrap gap-1.5">{selectItemAssessmentGroups(assessment).map(group => <Chip key={group.status} tone={selectStatusTone(group.status)}>{group.count} {CRITERION_STATUS_LABEL[group.status]}</Chip>)}</div>
    {review.itemGrading?.renderShowAll(selectFindingSelections(review.source, selectAssessmentItemPaths(assessment)))}
  </header>;
}

function ItemsPanel({ assessment, review }: { assessment: CurrentAssessment; review: AssessmentReviewSlots }) {
  const [filter, setFilter] = useState<AssessmentStatusFilter>("all");
  return <div className="flex flex-col gap-3">
    <label>Status filter <Select aria-label="Status filter" value={filter} onChange={event => setFilter(event.target.value as AssessmentStatusFilter)}>
      <option value="all">All statuses</option><option value="needs_attention">Partial / not met</option><option value="not_met">Not met</option><option value="partial">Partial</option><option value="met">Met</option>
    </Select></label>
    <CurrentBuildItemAssessmentViewer assessment={assessment} filter={filter} {...review} />
  </div>;
}

function FindingsPanel({ assessment, findings, review }: { assessment: CurrentAssessment; findings: readonly AttributedFinding[]; review: AssessmentReviewSlots }) {
  return <section data-testid="or-assessment-additional-findings">
    {findings.length === 0 && <p className="text-sm text-[var(--text-muted)]">No additional findings.</p>}
    <ul className="m-0 flex list-none flex-col gap-3 p-0">{findings.map(({ finding, labels, is_unattributed }) => <li key={finding.id} className="flex flex-col gap-2 rounded-md border border-[var(--border-decorative)] p-3">
      <div className="flex flex-wrap items-center gap-2"><code className="or-code">{finding.id}</code><Chip tone={selectStatusTone(finding.severity)}>{finding.severity}</Chip>
        {is_unattributed ? <Chip tone="muted">Unattributed</Chip> : labels.map(label => <Chip key={label.id} tone="neutral">{label.id}: {label.label}</Chip>)}</div>
      <p>{finding.observation}</p>
      <EvidenceRefList refs={finding.evidence.map(ref => ({ ...ref, detail: ref.detail ?? null }))} />
      <section aria-label="Observation grade" className="flex items-center gap-2"><span className={artifactLabelClass}>Observation grade</span><ArtifactItemGrade source={review.source} itemPath={`/additional_findings/${assessment.additional_findings.indexOf(finding)}`} itemGrading={review.itemGrading} onOpenItem={review.onOpenItem} /></section>
    </li>)}</ul>
  </section>;
}

function ActionsPanel({ assessment, handoff }: { assessment: CurrentAssessment; handoff: ReactNode }) {
  if (handoff) return <>{handoff}</>;
  const actions = selectAssessmentActions(assessment);
  return <>{(["builder", "operator"] as const).map(audience => <ArtifactSection key={audience} title={`${audience === "builder" ? "Builder" : "Operator"} actions (${actions[audience].length})`} testId={`or-${audience}-actions`}>
    {actions[audience].length === 0 ? <p className="text-sm text-[var(--text-muted)]">None.</p> : <ul>{actions[audience].map(action => <li key={action.id}>{action.text}</li>)}</ul>}
  </ArtifactSection>)}</>;
}

export function CurrentAssessmentViewer({ assessment, itemLabels, handoff, decisionBar, initialSection = "items", ...review }: CurrentAssessmentProps) {
  const findings = selectAdditionalFindings(assessment, itemLabels);
  return <article className="flex flex-col gap-4" data-testid="or-assessment-viewer">
    <CurrentAssessmentHeader assessment={assessment} review={review} />
    {decisionBar}
    <ArtifactSectionTabs<AssessmentSection> label="Assessment sections" sections={selectAssessmentSections(assessment)} initial={initialSection}>{() => ({
      items: <ItemsPanel assessment={assessment} review={review} />,
      findings: <FindingsPanel assessment={assessment} findings={findings} review={review} />,
      actions: <ActionsPanel assessment={assessment} handoff={handoff} />,
      tests: <TestEvidenceBlock tests={{ ...assessment.test_evidence, output: assessment.test_evidence.output ?? null, summary: assessment.test_evidence.summary ?? null, cargo_test_output: assessment.test_evidence.cargo_test_output ?? null }} testId="or-assessment-tests" />,
    })}</ArtifactSectionTabs>
  </article>;
}
