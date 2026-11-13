import type { ObservationEvidenceReference } from "../grading-contracts/grading/evidence";
import type { ObservationItemOccurrenceId } from "../grading-contracts/domain/identity";
import type { ObservationLogicalLinkRead, ObservationUnresolvedReferenceRead } from "../grading-contracts/grading/item-reads";
import type { ObservationQuestionStatusResponse } from "../grading-contracts/storage/grading-record-store";
import { referenceDisplay, type ReferenceDisplay } from "./grading";
import { decodeEvidenceContent, type EvidenceContent } from "./evidence-content";

export type EvidenceProvenance = "artifact_revision" | "run_input" | "repository_file_at_commit" | "agent_reported";
export interface GradingEvidenceDetail {
  readonly provenance: EvidenceProvenance;
  readonly provenance_label: "Reported" | "Independently retrieved";
  readonly display: ReferenceDisplay;
  readonly inspection: { readonly kind: "evidence_content"; readonly content: EvidenceContent };
}
const provenanceBySource: { readonly [Source in ObservationEvidenceReference["source"]]: EvidenceProvenance } = {
  revision: "artifact_revision", run_input: "run_input", repository: "repository_file_at_commit", reported: "agent_reported",
};
/** Recorded source is the sole classifier; prose and reference names never decide provenance. */
export const selectGradingEvidence = (reference: ObservationEvidenceReference): GradingEvidenceDetail => ({
  provenance: provenanceBySource[reference.source], provenance_label: reference.source === "reported" ? "Reported" : "Independently retrieved",
  display: referenceDisplay(reference), inspection: { kind: "evidence_content", content: decodeEvidenceContent(reference) },
});
/** Include historical answer definitions, even if that evaluator is absent from the machine window. */
export const selectEvaluatorDefinitionIds = (question: ObservationQuestionStatusResponse): readonly string[] => [...new Set([
  ...question.machine.items.map((machine) => machine.evaluator_definition_id),
  ...question.answers.items.map((answer) => answer.grader.evaluator_definition_id),
  ...question.superseded_answers.items.map((answer) => answer.grader.evaluator_definition_id),
])];
export interface UnresolvedTaskAssociation { readonly relation_id: string; readonly reference: string; readonly evidence_ref: string }
interface TaskAssociationSource {
  readonly occurrence_id: ObservationItemOccurrenceId;
  readonly links: readonly ObservationLogicalLinkRead[];
  readonly unresolved: readonly ObservationUnresolvedReferenceRead[];
}
export function selectUnresolvedTaskAssociations({ occurrence_id, links, unresolved }: TaskAssociationSource): readonly UnresolvedTaskAssociation[] {
  const entries = [
    ...links.flatMap((link) => link.state === "unresolved" ? [{ relation_id: link.relation_id, reference: link.unresolved_target_ref, evidence_ref: link.evidence_ref }] : []),
    ...unresolved.filter(({ item }) => item.occurrence_id === occurrence_id).map((row) => ({ relation_id: row.relation_id, reference: row.unresolved_target_ref, evidence_ref: row.evidence_ref })),
  ];
  return [...new Map(entries.map((entry) => [entry.relation_id, entry])).values()];
}
