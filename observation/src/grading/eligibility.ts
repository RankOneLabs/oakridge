import type { ItemOccurrenceId, QuestionId } from "../domain/identity";
import type { EvidenceSet } from "./evidence";

/** Reasons shared by eligibility storage and population coverage. */
export type ExclusionReason =
  | { readonly kind: "uncited" }
  | { readonly kind: "dangling_citation"; readonly evidence_refs: readonly string[] }
  | { readonly kind: "unlinked" }
  | { readonly kind: "unevidenced" }
  | { readonly kind: "skipped_budget"; readonly detail: string };

export type EligibilityDecision =
  | { readonly tag: "eligible"; readonly payload: { readonly evidence_set_id: string } }
  | { readonly tag: "inapplicable"; readonly payload: { readonly reason: string } }
  | { readonly tag: "missing_evidence"; readonly payload: ExclusionReason | { readonly kind: "missing_source"; readonly detail: string } }
  | { readonly tag: "invalid_reference"; readonly payload: Extract<ExclusionReason, { kind: "dangling_citation" | "unlinked" }> }
  | { readonly tag: "blocked_dependency"; readonly payload: { readonly dependency: string; readonly detail: string } }
  | { readonly tag: "skipped_budget"; readonly payload: Extract<ExclusionReason, { kind: "skipped_budget" }> };

export type EligibilityRow = EligibilityDecision & {
  readonly producer: string;
  readonly namespace: string;
  readonly subject_occurrence_id: ItemOccurrenceId;
  readonly question_id: QuestionId;
  readonly question_version: string;
};

export function exclusionReason(decision: EligibilityDecision): ExclusionReason | null {
  if (decision.tag === "invalid_reference" || decision.tag === "skipped_budget") return decision.payload;
  if (decision.tag === "missing_evidence" && decision.payload.kind !== "missing_source") return decision.payload;
  return null;
}

export function eligibilityExclusionCounts(decisions: readonly EligibilityDecision[]) {
  const reasons = decisions.map(exclusionReason).filter((reason): reason is ExclusionReason => reason !== null);
  return {
    uncited: reasons.filter((reason) => reason.kind === "uncited").length,
    dangling_citation: reasons.filter((reason) => reason.kind === "dangling_citation").length,
    unlinked: reasons.filter((reason) => reason.kind === "unlinked").length,
    unevidenced: reasons.filter((reason) => reason.kind === "unevidenced").length,
    skipped_budget: reasons.filter((reason) => reason.kind === "skipped_budget").length,
  };
}

export function repositorySnapshotEligibility(evidence: EvidenceSet, minimum_count: number, reviewed_commit: string): EligibilityDecision {
  const references = evidence.references.filter((reference) => reference.kind === "repository_content" ||
    reference.ref.startsWith("relevant_excerpt:") || reference.ref.startsWith("repository_content:"));
  if (references.length < Math.max(1, minimum_count))
    return { tag: "missing_evidence", payload: { kind: "missing_source", detail: "too few repository content references" } };
  if (references.some((reference) => reference.kind !== "repository_content"))
    return { tag: "missing_evidence", payload: { kind: "missing_source", detail: "repository reference has no repository_content classification" } };
  if (!reviewed_commit || references.some((reference) => reference.reviewed_commit !== reviewed_commit))
    return { tag: "missing_evidence", payload: { kind: "missing_source", detail: "repository reference has no matching reviewed commit" } };
  if (references.some((reference) => !reference.digest?.startsWith("canonical-json/v1:") ||
    ((reference.is_truncated || reference.is_unreadable) && !reference.incompleteness_reason)))
    return { tag: "missing_evidence", payload: { kind: "missing_source", detail: "repository excerpt lacks canonical digest or incompleteness reason" } };
  return { tag: "eligible", payload: { evidence_set_id: evidence.evidence_set_id } };
}
