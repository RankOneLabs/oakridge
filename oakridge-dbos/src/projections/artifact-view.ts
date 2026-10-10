import type { CheckedValue } from "../core-client/generated-contracts";
import type { RunId, ScopeId } from "../storage/schema-records";
import type { OutputSlotView } from "./scope-view";

/** Review status belongs to the operator projection, not the revision row. */
export type ArtifactRevisionStatus = "draft" | "approved" | "rejected";

export interface ArtifactDetail {
  readonly run_id: RunId;
  readonly scope_id: ScopeId;
  readonly output_key: string;
  readonly collection_key: string;
  readonly slot_version: number;
  readonly revision_id: string | null;
  readonly predecessor_id: string | null;
  readonly body: CheckedValue | null;
  readonly status: ArtifactRevisionStatus;
}

export function selectArtifactDetail(slot: OutputSlotView, status: ArtifactRevisionStatus): ArtifactDetail {
  return { run_id: slot.run_id, scope_id: slot.scope_id, output_key: slot.output_key,
    collection_key: slot.collection_key, slot_version: slot.version,
    revision_id: slot.current_revision?.id ?? null,
    predecessor_id: slot.current_revision?.predecessor_id ?? null,
    body: slot.current_revision?.body ?? null, status };
}
