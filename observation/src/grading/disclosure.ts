import type { EvidenceSet } from "./evidence";
import type { Result } from "../domain/primitives";
import { err, ok } from "../domain/primitives";
import { canonicalDigest } from "../canonical/canonical-json";

export const DISCLOSURE_POLICY_VERSION = "observation-outbound/v1";
export interface DisclosureRecord { readonly provider: string; readonly policy_version: string;
  readonly manifest_digests: readonly string[]; readonly content_types: readonly string[] }
export interface DisclosureRefusal { readonly operation: "disclosure"; readonly entity_id: string; readonly detail: string }
/** Default deny includes legacy rows with no classification. */
export function checkDisclosure(evidence: EvidenceSet, provider: string): Result<DisclosureRecord, DisclosureRefusal> {
  if (evidence.references.some((ref) => ref.kind !== "public" && ref.kind !== "repository_content"))
    return err({ operation: "disclosure", entity_id: evidence.evidence_set_id, detail: "unclassified or restricted evidence" });
  const digests = evidence.references.map((ref) => ref.digest ? ok(ref.digest) : canonicalDigest(ref.content));
  if (digests.some((digest) => !digest.ok))
    return err({ operation: "disclosure", entity_id: evidence.evidence_set_id, detail: "evidence content has no canonical digest" });
  return ok({ provider, policy_version: DISCLOSURE_POLICY_VERSION,
    manifest_digests: digests.flatMap((digest) => digest.ok ? [digest.value] : []),
    content_types: evidence.references.map((ref) => ref.kind!) });
}
