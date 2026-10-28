import type { ItemOccurrenceId } from "../domain/identity";
import type { JsonValue } from "../domain/primitives";
import type { EvidenceSet } from "../grading/evidence";

export interface SourceArtifact {
  readonly occurrence_id: ItemOccurrenceId;
  readonly item_kind: string;
  readonly selected_value: JsonValue;
}
export interface ArtifactSource {
  read(occurrence_id: ItemOccurrenceId): Promise<SourceArtifact | null>;
  collect(artifact: SourceArtifact): Promise<EvidenceSet>;
}
