import { Chip } from "../../../components/atoms/Chip";
import { selectStatusTone } from "../../lib/status-tone";
import type { CriterionStatus } from "../../artifact-types";
import { EvidenceRefList } from "./EvidenceRefList";
import type { OperatorItemAssessment } from "../../operator-contracts/domain/assessment";
import { selectSubjectKindLabel } from "../../lib/current-assessment";
import type { ViewerProps } from "../../artifactRegistry";
import { ArtifactItemGrade } from "./ArtifactItemGrade";
export const CRITERION_STATUS_LABEL: Record<CriterionStatus, string> = { met: "met", partial: "partial", not_met: "not met" };
interface CurrentItemProps extends Pick<ViewerProps, "source" | "itemGrading" | "onOpenItem"> {
  readonly item: OperatorItemAssessment; readonly index: number;
}
export function CurrentCriterionCheckItem({ item, index, source, itemGrading, onOpenItem }: CurrentItemProps) {
  return <li data-testid="or-criterion-check" data-status={item.status} className={`flex flex-col gap-2 rounded-md border p-3 ${item.status === "met" ? "border-[var(--border-decorative)]" : "border-[var(--amber-border)] bg-[var(--amber-bg)]"}`}>
    <div className="flex items-center gap-2"><strong>{selectSubjectKindLabel(item.subject.kind)} {item.subject.id}</strong>
      <span aria-label="Assessor status"><Chip tone={selectStatusTone(item.status)}>{CRITERION_STATUS_LABEL[item.status]}</Chip></span></div>
    <p>{item.observation}</p>
    <EvidenceRefList refs={item.evidence.map(ref => ({ ...ref, detail: ref.detail ?? null }))} />
    <section aria-label="Observation grade" className="border-t border-[var(--border-decorative)] pt-2">
      <span className="text-xs text-[var(--text-muted)]">Observation grade</span>
      <ArtifactItemGrade source={source} itemPath={`/item_assessments/${index}`} itemGrading={itemGrading} onOpenItem={onOpenItem} />
    </section>
  </li>;
}
