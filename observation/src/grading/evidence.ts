import { canonicalDigest } from "canonical-json";
import type { EvidenceSetId, ItemOccurrenceId, QuestionId } from "../domain/identity";
import { ok } from "../domain/primitives";
import type { CanonicalizationError } from "../domain/errors";
import type { JsonValue, Result } from "../domain/primitives";

export interface EvidenceReference {
  readonly ref: string;
  readonly content: JsonValue | null;
  readonly deep_link?: string;
  readonly reviewed_commit?: string;
  readonly is_truncated?: boolean;
  readonly is_unreadable?: boolean;
  readonly incompleteness_reason?: string;
}
export interface EvidenceIdentity {
  readonly subject_occurrence_id: ItemOccurrenceId;
  readonly question_id: QuestionId;
  readonly question_version: string;
}
export interface EvidenceSet extends EvidenceIdentity {
  readonly evidence_set_id: EvidenceSetId;
  readonly references: readonly EvidenceReference[];
  readonly is_incomplete: boolean;
  readonly incompleteness_reason: string | null;
}
/** Stable across readiness changes: content is frozen once the set is ready. */
export function evidenceSetId(identity: EvidenceIdentity): Result<EvidenceSetId, CanonicalizationError> {
  const digest = canonicalDigest([identity.subject_occurrence_id, identity.question_id, identity.question_version]);
  return digest.ok ? ok(digest.value as unknown as EvidenceSetId) : digest;
}
