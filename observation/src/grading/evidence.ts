import { canonicalDigest } from "../canonical/canonical-json";
import type { CanonicalDigest, EvidenceSetId } from "../domain/identity";
import { err, type JsonValue, type Result } from "../domain/primitives";

export type EvidenceKind = "raw_build_output" | "raw_test_output" | "repository_content" | "public" | "internal";
export interface EvidenceReference {
  readonly ref: string;
  /** Classification at capture time; internal content is withheld on export. */
  readonly kind: EvidenceKind;
  readonly content: JsonValue | null;
  readonly digest: string | null;
  readonly deep_link?: string;
  readonly reviewed_commit?: string;
  readonly is_truncated?: boolean;
  readonly is_unreadable?: boolean;
  readonly incompleteness_reason?: string;
}
/** Pre-migration rows can lack classification and are denied by disclosure. */
export type StoredEvidenceReference = Omit<EvidenceReference, "kind"> & { readonly kind?: EvidenceKind };
export interface EvidenceSet {
  readonly evidence_set_id: EvidenceSetId;
  readonly references: readonly StoredEvidenceReference[];
  readonly is_incomplete: boolean;
  readonly incompleteness_reason: string | null;
}

export interface EvidenceDigestError { readonly operation: "evidence_set_digest"; readonly entity_id: string; readonly detail: string }
/** Mirrors the Assay export digest input, including the captured reference content. */
export function evidenceSetDigest(evidence: EvidenceSet): Result<CanonicalDigest, EvidenceDigestError> {
  const result = canonicalDigest({ evidence_refs: evidence.references, is_incomplete: evidence.is_incomplete,
    incompleteness_reason: evidence.incompleteness_reason });
  return result.ok ? result : err({ operation: "evidence_set_digest", entity_id: evidence.evidence_set_id,
    detail: result.error.detail });
}
