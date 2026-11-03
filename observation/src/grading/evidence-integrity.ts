import { canonicalDigest } from "canonical-json";
import { err, ok, type Result } from "../domain/primitives";
import type { EvidenceSet } from "./evidence";

export interface EvidenceIntegrityFailure {
  readonly operation: "evidence_integrity";
  readonly entity_id: string;
  readonly detail: string;
}

/** Every reference must identify captured content by a supplied or computable digest. */
export function checkEvidenceIntegrity(evidence: EvidenceSet): Result<void, EvidenceIntegrityFailure> {
  const has_missing_digest = evidence.references.some((reference) => !reference.digest
    && (reference.content === null || !canonicalDigest(reference.content).ok));
  if (has_missing_digest) return err({ operation: "evidence_integrity", entity_id: evidence.evidence_set_id,
    detail: "evidence content has no canonical digest" });
  return ok(undefined);
}
