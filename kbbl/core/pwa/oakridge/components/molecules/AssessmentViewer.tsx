import { Select } from "../../../components/atoms/Select";
import { BuildItemAssessmentViewer } from "./BuildItemAssessmentViewer";
import { useState, type ReactNode } from "react";
import { Button } from "../../../components/atoms/Button";
import { Chip } from "../../../components/atoms/Chip";
import { selectAssessmentForBrief, selectCriterionCounts, selectCriterionReport, type LegacyAssessment, type CriterionCheck, type CriterionTally } from "../../lib/assessment";
import type { BuildBrief } from "../../lib/build-brief";
import type { BuildResult } from "../../lib/build-result";
import type { CohortArtifactLookup } from "../../lib/cohort-artifact";
import { selectStatusTone } from "../../lib/status-tone";
import type { ArtifactSource, AssessmentVerdict } from "../../artifact-types";
import type { ObservationItemAddress } from "../../grading-contracts/grading/item-reads";
import type { ItemGradingSlots } from "../../artifactRegistry";
import { selectFindingSelections, selectItemSelection } from "../../lib/grading";
import { ArtifactSection, artifactLabelClass } from "./ArtifactSection";
import { CohortArtifactNote } from "./CohortArtifactNote";
import { GradeItemButton } from "./GradeItemButton";
import { CRITERION_STATUS_LABEL, CriterionCheckItem } from "./CriterionCheckItem";
import { TestEvidenceBlock } from "./TestEvidenceBlock";

interface Props {
  assessment: LegacyAssessment;
  brief: CohortArtifactLookup<BuildBrief>;
  result: CohortArtifactLookup<BuildResult>;
  cohortLabel: string | null;
  isIntegration?: boolean;
  handoff?: ReactNode;
  /** The revision on screen, which addresses its findings. */
  source?: Pick<ArtifactSource, "revision_id">;
  onOpenTask?: (taskId: string) => void;
  onOpenItem?: (selection: ObservationItemAddress) => void;
  itemGrading?: ItemGradingSlots;
}

const VERDICT_LABEL: Record<AssessmentVerdict, string> = { pass: "Pass", pass_with_notes: "Pass with notes", fail: "Fail" };
const VERDICT_BANNER_CLASS: Record<AssessmentVerdict, string> = {
  pass: "border-[var(--badge-success-border)] bg-[var(--bg-surface)]",
  pass_with_notes: "border-[var(--amber-border)] bg-[var(--amber-bg)]",
  fail: "border-[var(--danger-card-border)] bg-[var(--danger-card-bg)]",
};

function VerdictBanner({ verdict, tally }: { verdict: AssessmentVerdict; tally: CriterionTally }) {
  return (
    <div className={`flex flex-wrap items-center gap-3 rounded-md border px-3 py-2.5 ${VERDICT_BANNER_CLASS[verdict]}`} data-testid="or-assessment-verdict-banner">
      <Chip tone={selectStatusTone(verdict)} testId="or-assessment-verdict">{VERDICT_LABEL[verdict]}</Chip>
      <div className="flex flex-wrap gap-1.5">
        {selectCriterionCounts(tally).map(({ status, count }) => (
          <Chip key={status ?? "unassessed"} tone={status ? selectStatusTone(status) : "muted"}>{count} {status ? CRITERION_STATUS_LABEL[status] : "not assessed"}</Chip>
        ))}
      </div>
    </div>
  );
}

function LegacyAssessmentViewer({ assessment, brief, result, cohortLabel, isIntegration = false, handoff, source, onOpenItem, itemGrading }: Props) {
  const [isMetOpen, setIsMetOpen] = useState(false);
  const report = selectCriterionReport(!isIntegration && brief.kind === "found" && brief.value.shape === "legacy" ? brief.value.acceptance_criteria : null, assessment.findings);
  const showBriefComparison = !isIntegration && brief.kind === "found";
  const findingSelections = selectFindingSelections(source, assessment.findings.map((finding) => finding.item_path));
  const renderGradeAction = (check: Extract<CriterionCheck, { kind: "finding" }>) => {
    const selection = selectItemSelection(source, check.finding.item_path);
    return selection && itemGrading ? itemGrading.renderItemAction(selection) : <GradeItemButton selection={selection} onOpenItem={onOpenItem} />;
  };

  return (
    <article className="flex flex-col gap-5" data-testid="or-assessment-viewer">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className={artifactLabelClass}>{isIntegration ? "Integration assessment" : "Assessment"}</span>
          {cohortLabel && <code className="or-code">{cohortLabel}</code>}
          {brief.kind === "found" && <Chip tone="neutral">{brief.value.repository_key}</Chip>}
        </div>
        {brief.kind === "found" && <h2 className="m-0 text-lg font-semibold leading-snug text-[var(--text-primary)]">{brief.value.title}</h2>}
        <p className="m-0 text-xs text-[var(--text-muted)]" data-testid="or-assessment-head-sha">Commit: <code className="or-code">{assessment.head_sha}</code></p>
        <VerdictBanner verdict={assessment.verdict} tally={report.tally} />
        {itemGrading?.renderShowAll(findingSelections)}
        {!isIntegration && brief.kind !== "found" && <CohortArtifactNote lookup={brief} artifactName="build brief" testId="or-assessment-brief-note" />}
      </header>

      <ArtifactSection title={`Needs attention (${report.needs_attention.length})`} testId="or-assessment-attention">
        {report.needs_attention.length > 0 ? (
          <ul className="m-0 list-none divide-y divide-[var(--border-decorative)] p-0">
            {report.needs_attention.map((check, index) => <CriterionCheckItem key={index} check={check} showBriefComparison={showBriefComparison} renderGradeAction={renderGradeAction} />)}
          </ul>
        ) : <p className="text-sm text-[var(--success-fg)]">Every finding is met and every task assessed.</p>}
      </ArtifactSection>

      {handoff ?? (assessment.recommended_next_actions.length > 0 && (
        <ArtifactSection title={`Recommended next actions (${assessment.recommended_next_actions.length})`} testId="or-assessment-next-actions">
          <ol className="m-0 flex list-decimal flex-col gap-1.5 rounded-md border-l-4 border-[var(--accent-primary)] bg-[var(--accent-muted)] py-2 pl-8 pr-3 text-sm text-[var(--text-primary)]">
            {assessment.recommended_next_actions.map((action) => <li key={action.id}>{action.text}</li>)}
          </ol>
        </ArtifactSection>
      ))}

      <ArtifactSection title="Tests" testId="or-assessment-tests-section">
        {assessment.test_evidence
          ? <TestEvidenceBlock tests={assessment.test_evidence} testId="or-assessment-tests" />
          : <p className="text-sm text-[var(--text-muted)]">The {isIntegration ? "integrator" : "assessor"} recorded no test run.</p>}
        {!isIntegration && (result.kind === "found" ? (
          <p className="text-xs text-[var(--text-muted)]" data-testid="or-assessment-builder-tests">
            The builder reported {result.value.tests.passed} passed and {result.value.tests.failed} failed.
          </p>
        ) : <CohortArtifactNote lookup={result} artifactName="build result" testId="or-assessment-result-note" />)}
      </ArtifactSection>

      {report.met.length > 0 && (
        <ArtifactSection title={`Met (${report.met.length})`} testId="or-assessment-met">
          <Button variant="secondary" size="xsmall" className="self-start text-xs!" aria-expanded={isMetOpen} onClick={() => setIsMetOpen(!isMetOpen)}>
            {isMetOpen ? "▾ Hide met criteria" : "▸ Show met criteria"}
          </Button>
          {isMetOpen && (
            <ul className="m-0 list-none divide-y divide-[var(--border-decorative)] p-0">
              {report.met.map((check, index) => <CriterionCheckItem key={index} check={check} showBriefComparison={showBriefComparison} renderGradeAction={renderGradeAction} />)}
            </ul>
          )}
        </ArtifactSection>
      )}
    </article>
  );
}

export function AssessmentViewer(props: Omit<Props, "assessment"> & { assessment: import("../../lib/assessment").Assessment }) {
  const assessment = selectAssessmentForBrief(props.assessment, !props.isIntegration && props.brief.kind === "found" ? props.brief.value : null);
  return assessment.shape === "build_items" ? <BuildItemAssessmentViewer {...props} assessment={assessment} /> : <LegacyAssessmentViewer {...props} assessment={assessment} />;
}

import { selectAdditionalFindings, selectAssessmentActions, selectAssessmentSections, selectDerivedVerdict, selectItemAssessmentGroups, type AssessmentItemLabel, type AssessmentSection, type AssessmentStatusFilter, type AttributedFinding, type CurrentAssessment } from "../../lib/current-assessment";
import { CurrentBuildItemAssessmentViewer } from "./BuildItemAssessmentViewer";
import { EvidenceRefList } from "./EvidenceRefList";
import { ArtifactItemGrade } from "./ArtifactItemGrade";
import { ArtifactSectionTabs } from "./ArtifactSectionTabs";
import { selectAssessmentItemPaths } from "../../lib/current-item-paths";
interface CurrentAssessmentProps extends Pick<import("../../artifactRegistry").ViewerProps, "source" | "itemGrading" | "onOpenItem"> {
  assessment: CurrentAssessment; itemLabels?: readonly AssessmentItemLabel[]; handoff?: ReactNode;
}
type AssessmentReviewSlots = Omit<CurrentAssessmentProps, "assessment" | "itemLabels" | "handoff">;

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

export function CurrentAssessmentViewer({ assessment, itemLabels, handoff, ...review }: CurrentAssessmentProps) {
  const findings = selectAdditionalFindings(assessment, itemLabels);
  return <article className="flex flex-col gap-4" data-testid="or-assessment-viewer">
    <CurrentAssessmentHeader assessment={assessment} review={review} />
    <ArtifactSectionTabs<AssessmentSection> label="Assessment sections" sections={selectAssessmentSections(assessment)} initial="items">{() => ({
      items: <ItemsPanel assessment={assessment} review={review} />,
      findings: <FindingsPanel assessment={assessment} findings={findings} review={review} />,
      actions: <ActionsPanel assessment={assessment} handoff={handoff} />,
      tests: <TestEvidenceBlock tests={{ ...assessment.test_evidence, output: assessment.test_evidence.output ?? null, summary: assessment.test_evidence.summary ?? null, cargo_test_output: assessment.test_evidence.cargo_test_output ?? null }} testId="or-assessment-tests" />,
    })}</ArtifactSectionTabs>
  </article>;
}
