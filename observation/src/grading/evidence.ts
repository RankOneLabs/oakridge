import type { EvidenceSetId } from "../domain/identity";
import type { JsonValue } from "../domain/primitives";

export interface EvidenceReference {
  readonly ref: string;
  readonly content: JsonValue | null;
  readonly digest: string | null;
}
export interface EvidenceSet {
  readonly evidence_set_id: EvidenceSetId;
  readonly references: readonly EvidenceReference[];
  readonly is_incomplete: boolean;
  readonly incompleteness_reason: string | null;
}
