import type { ViewerProps } from "../../artifactRegistry";
import { ArtifactSection } from "./ArtifactSection";
import type { CurrentAssessment, AssessmentStatusFilter } from "../../lib/current-assessment";
import { selectItemAssessmentGroups } from "../../lib/current-assessment";
import { CurrentCriterionCheckItem } from "./CriterionCheckItem";
interface CurrentProps extends Pick<ViewerProps, "source" | "itemGrading" | "onOpenItem"> { assessment: CurrentAssessment; filter: AssessmentStatusFilter }
export function CurrentBuildItemAssessmentViewer({ assessment, filter, ...review }: CurrentProps) {
  const groups = selectItemAssessmentGroups(assessment, filter);
  return <>{groups.filter(group => group.count > 0).map(group => <ArtifactSection key={group.status} title={`${group.status.replaceAll("_", " ")} (${group.count})`} testId={`or-assessment-${group.status}`}>
    <ul className="m-0 flex list-none flex-col gap-2 p-0">{group.items.map(item => <CurrentCriterionCheckItem key={`${item.subject.kind}:${item.subject.id}`} item={item}
      index={assessment.item_assessments.indexOf(item)} {...review} />)}</ul>
  </ArtifactSection>)}</>;
}
