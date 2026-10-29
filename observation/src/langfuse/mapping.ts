import { canonicalDigest } from "../canonical/canonical-json";
import type { CanonicalDigest, ItemOccurrenceId, QuestionId } from "../domain/identity";
import { err, ok, type Result } from "../domain/primitives";
import type { EvidenceSet } from "../grading/evidence";
import type { ExternalTargetIds, LangfuseError } from "../ports/evaluation-backend";
import type { LangfuseSyncState } from "./sync-state";

export interface MappingKeyInput {
  readonly occurrence_id: ItemOccurrenceId;
  readonly evidence: EvidenceSet;
  readonly question_id: QuestionId;
  readonly question_version: string;
  readonly projection_version: string;
}
export interface MappingDigests {
  readonly mapping_key: CanonicalDigest;
  readonly evidence_set_digest: CanonicalDigest;
}
export interface LangfuseMappingRecord extends MappingDigests {
  readonly occurrence_id: ItemOccurrenceId;
  readonly evidence_set_id: EvidenceSet["evidence_set_id"];
  readonly question_id: QuestionId;
  readonly question_version: string;
  readonly projection_version: string;
  readonly external_ids: ExternalTargetIds | null;
  readonly sync_state: LangfuseSyncState;
}

/** Mirrors the Assay export digest input, including the captured reference content. */
export function evidenceSetDigest(evidence: EvidenceSet): Result<CanonicalDigest, LangfuseError> {
  const result = canonicalDigest({ evidence_refs: evidence.references, is_incomplete: evidence.is_incomplete,
    incompleteness_reason: evidence.incompleteness_reason });
  return result.ok ? result : err({ operation: "evidence_set_digest", entity_id: evidence.evidence_set_id,
    detail: result.error.detail });
}

/** A new shape version makes a new key; prior keys remain computable unchanged. */
export function mappingKey(input: MappingKeyInput): Result<MappingDigests, LangfuseError> {
  const evidence = evidenceSetDigest(input.evidence);
  if (!evidence.ok) return evidence;
  const result = canonicalDigest([input.occurrence_id, evidence.value, input.question_id,
    input.question_version, input.projection_version]);
  return result.ok ? ok({ mapping_key: result.value, evidence_set_digest: evidence.value })
    : err({ operation: "mapping_key", entity_id: input.occurrence_id, detail: result.error.detail });
}
