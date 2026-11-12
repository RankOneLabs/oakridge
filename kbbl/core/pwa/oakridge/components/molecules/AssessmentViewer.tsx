import { useState, type ReactNode } from "react";
import { Button } from "../../../components/atoms/Button";
import { Chip } from "../../../components/atoms/Chip";
import { selectCriterionCounts, selectCriterionReport, type Assessment, type CriterionCheck, type CriterionTally } from "../../lib/assessment";
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
  assessment: Assessment;
  brief: CohortArtifactLookup<BuildBrief>;
  result: CohortArtifactLookup<BuildResult>;
  cohortLabel: string | null;
  isIntegration?: boolean;
  handoff?: ReactNode;
  /** The revision on screen, which addresses its findings. */
  source?: Pick<ArtifactSource, "revision_id">;
  onOpenItem?: (selection: ObservationItemAddress) => void;
  itemGrading?: ItemGradingSlots;
}

const VERDICT_LABEL: Record<AssessmentVerdict, string> = { pass: "Pass", pass_with_notes: "Pass with notes", fail: "Fail" };
const VERDICT_BANNER_CLASS: Record<AssessmentVerdict, string> = {
  pass: "border-emerald-500 bg-[var(--bg-surface)]",
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

export function AssessmentViewer({ assessment, brief, result, cohortLabel, isIntegration = false, handoff, source, onOpenItem, itemGrading }: Props) {
  const [isMetOpen, setIsMetOpen] = useState(false);
  const report = selectCriterionReport(!isIntegration && brief.kind === "found" ? brief.value.acceptance_criteria : null, assessment.findings);
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
