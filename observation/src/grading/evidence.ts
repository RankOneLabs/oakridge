import type { EvidenceSetId } from "../domain/identity";
import type { JsonValue } from "../domain/primitives";

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
