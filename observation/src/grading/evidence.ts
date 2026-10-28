import type { EvidenceSetId } from "../domain/identity";
import type { JsonValue } from "../domain/primitives";

export interface EvidenceReference {
  readonly ref: string;
  /** Classification at capture time; unclassified content is withheld on export. */
  readonly kind?: "raw_build_output" | "raw_test_output" | "repository_content" | "public";
  readonly content: JsonValue | null;
  readonly digest: string | null;
}
export interface EvidenceSet {
  readonly evidence_set_id: EvidenceSetId;
  readonly references: readonly EvidenceReference[];
  readonly is_incomplete: boolean;
  readonly incompleteness_reason: string | null;
}
