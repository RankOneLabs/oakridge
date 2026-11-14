import type { BuildItemAssessment } from "../../lib/assessment";
import { selectFindingSelections, selectItemSelection } from "../../lib/grading";
import { selectBuildItemReport } from "../../lib/assessment";
import type { BuildBrief } from "../../lib/build-brief";
import type { CohortArtifactLookup } from "../../lib/cohort-artifact";
import type { ViewerProps } from "../../artifactRegistry";
import { ArtifactSection } from "./ArtifactSection";
import { GradeItemButton } from "./GradeItemButton";
import { EvidenceContentView } from "./EvidenceContentView";
import { TestEvidenceBlock } from "./TestEvidenceBlock";

interface Props extends Pick<ViewerProps, "onOpenItem" | "itemGrading"> {
  source?: Pick<import("../../artifact-types").ArtifactSource, "revision_id">;
  assessment: BuildItemAssessment;
  brief: CohortArtifactLookup<BuildBrief>;
  isIntegration?: boolean;
  handoff?: React.ReactNode;
}
export function BuildItemAssessmentViewer({ assessment, brief, isIntegration, source, onOpenItem, itemGrading, handoff }: Props) {
  const report = selectBuildItemReport(!isIntegration && brief.kind === "found" && brief.value.shape === "build_items" ? brief.value : null, assessment.findings);
  return <article data-testid="or-assessment-viewer" className="flex flex-col gap-5">
    <header><h2>Assessment: {assessment.verdict}</h2><code>{assessment.head_sha}</code></header>
    {source && itemGrading?.renderShowAll(selectFindingSelections(source, assessment.findings.map((finding) => finding.item_path)))}
    {report.map((group) => <ArtifactSection key={group.label} title={group.label} testId={`or-build-item-${group.label}`}>
      <ul>{group.rows.map((row, index) => <li key={index}>
        {row.unresolved_subjects?.map((subject) => <p key={`${subject.cohort_id}/${subject.id}`}>Unresolved build item: <code>{subject.cohort_id ? `${subject.cohort_id}/` : ""}{subject.id}</code></p>)}
        {row.item && <p><code>{row.item.id}</code> {row.item.description}</p>}
        {row.findings.length === 0 && <p>Not assessed</p>}
        {row.findings.map((finding) => <div key={finding.item_path}>
          <p>{finding.status === "met" ? "Met (assessor's judgment)" : finding.status ?? "No status"}</p>
          <EvidenceContentView content={{ kind: "assessment_finding", value: finding }} />
          {source && itemGrading ? itemGrading.renderItemAction(selectFindingSelections(source, [finding.item_path])[0]!) : <GradeItemButton selection={selectItemSelection(source, finding.item_path)} onOpenItem={onOpenItem} />}
        </div>)}
      </li>)}</ul>
    </ArtifactSection>)}
    {handoff ?? <ArtifactSection title="Recommended next actions" testId="or-assessment-next-actions"><ul>{assessment.recommended_next_actions.map((action) => <li key={action.id}>{action.text}</li>)}</ul></ArtifactSection>}
    {assessment.test_evidence && <TestEvidenceBlock tests={assessment.test_evidence} testId="or-assessment-tests" />}
  </article>;
}
