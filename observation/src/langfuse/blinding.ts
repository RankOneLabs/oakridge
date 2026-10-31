import { err, ok, type Result } from "../domain/primitives";
import type { GradeObservationListing } from "../grading/observation";
import type { QuestionDefinition } from "../grading/question";
import { projectPilotEvidence, type EvidenceSource, type ProjectedQuestionEvidence } from "./evidence-recipe";
import type { StoredEvidenceReference } from "../grading/evidence";

function exposesAssessorDecision(address: string | null): boolean {
  return address !== null && /(?:^|[\/#?._-])(verdict|decision|effect)(?:$|[\/#?._=&-])/i.test(address);
}

export interface BlindedEvidenceAddress {
  readonly ref: string;
  readonly digest: string | null;
  readonly deep_link: string | null;
}

export function blindReferenceAddresses(references: readonly StoredEvidenceReference[])
  : Result<readonly BlindedEvidenceAddress[], BlindingError> {
  const addresses = references.map((reference) => ({ ref: reference.ref,
    digest: reference.digest, deep_link: reference.deep_link ?? null }));
  if (addresses.some((source) => [source.ref, source.deep_link].some(exposesAssessorDecision)))
    return err({ operation: "blind_evidence", entity_id: "evidence_set",
      detail: "evidence address exposes an assessor decision" });
  return ok(addresses);
}

export interface BlindedEvidencePackage extends ProjectedQuestionEvidence {
  readonly question_id: QuestionDefinition["question_id"];
  readonly question_version: string;
  readonly graded_artifact: "report" | "code";
}
export interface BlindingError { readonly operation: "blind_evidence"; readonly entity_id: string; readonly detail: string }

/** Pinned role references only; assessor decisions never become package fields. */
export function blindEvidence(question: QuestionDefinition, sources: readonly EvidenceSource[],
  graded_artifact: "report" | "code"): Result<BlindedEvidencePackage, BlindingError> {
  const projected = projectPilotEvidence(question, sources);
  if (!projected.ok) return err({ operation: "blind_evidence", entity_id: question.question_id, detail: projected.error.detail });
  if (sources.some((source) => [source.ref, source.deep_link].some(exposesAssessorDecision)))
    return err({ operation: "blind_evidence", entity_id: question.question_id,
      detail: "evidence address exposes an assessor decision" });
  return ok({ ...projected.value, question_id: question.question_id,
    question_version: question.question_version, graded_artifact });
}

export interface CollaborationLabel { readonly event_id: string; readonly revision_id: string | null;
  readonly anchor: string | null; readonly body: unknown }
export interface LabelSeries {
  readonly held_out: readonly GradeObservationListing[];
  readonly oakridge_operator_unblinded: readonly GradeObservationListing[];
  readonly collaboration_unblinded: readonly CollaborationLabel[];
}

/** A positive origin allowlist prevents any other human grade from becoming held-out by accident. */
export function separateLabelSeries(grades: readonly GradeObservationListing[],
  collaboration: readonly CollaborationLabel[]): LabelSeries {
  return { held_out: grades.filter((grade) => grade.label_origin === "langfuse_annotation_blinded"
    || grade.collection_mode === "blind"),
    oakridge_operator_unblinded: grades.filter((grade) => grade.label_origin === "oakridge_operator_unblinded"),
    collaboration_unblinded: collaboration };
}

export type SampleStratum = "clearly_easy" | "borderline" | "known_failure";
export interface BlindSampleCandidate { readonly occurrence_id: string; readonly stratum: SampleStratum;
  readonly has_split_criterion: boolean; readonly has_false_verified_claim: boolean }
export interface BlindSamplePlan { readonly per_stratum: Readonly<Record<SampleStratum, number>> }
export interface BlindSampleError { readonly operation: "select_blind_sample"; readonly entity_id: string; readonly detail: string }

/** Candidate ordering uses pinned IDs and declared strata only, never operator verdicts. */
export function selectBlindSample(candidates: readonly BlindSampleCandidate[], plan: BlindSamplePlan)
  : Result<readonly BlindSampleCandidate[], BlindSampleError> {
  if (!Object.values(plan.per_stratum).every((count) => Number.isInteger(count) && count > 0))
    return err({ operation: "select_blind_sample", entity_id: "pilot", detail: "each stratum requires a positive count" });
  const selected = (["clearly_easy", "borderline", "known_failure"] as const).flatMap((stratum) =>
    candidates.filter((candidate) => candidate.stratum === stratum)
      .sort((left, right) => left.occurrence_id.localeCompare(right.occurrence_id))
      .slice(0, plan.per_stratum[stratum]));
  if (selected.length !== Object.values(plan.per_stratum).reduce((sum, count) => sum + count, 0)
    || new Set(selected.map((candidate) => candidate.occurrence_id)).size !== selected.length
    || !selected.some((candidate) => candidate.has_split_criterion)
    || !selected.some((candidate) => candidate.has_false_verified_claim))
    return err({ operation: "select_blind_sample", entity_id: "pilot", detail: "sample lacks requested strata or required cases" });
  return ok(selected);
}
