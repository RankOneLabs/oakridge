// Generated from observation/src/http/grading-api.ts. Run bun kbbl/scripts/generate-grading-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

import type { ObservationItemOccurrenceId, ObservationLogicalItemId, ObservationRelationId } from "../domain/identity";

export interface ObservationLineagePage { readonly occurrence_id: ObservationItemOccurrenceId; readonly relations: readonly ObservationItemRelationRead[];
  readonly edges: readonly ObservationItemRelationRead[];
  readonly unresolved: readonly ObservationItemRelationRead[]; readonly total: number;
  readonly limit: number; readonly offset: number; readonly republication: ObservationRepublication | null }

export interface ObservationItemRelationRead {
  readonly producer: string;
  readonly namespace: string;
  readonly relation_id: ObservationRelationId;
  readonly source_occurrence_id: ObservationItemOccurrenceId | null;
  readonly source_logical_item_id: ObservationLogicalItemId | null;
  readonly target_occurrence_id: ObservationItemOccurrenceId | null;
  readonly target_logical_item_id: ObservationLogicalItemId | null;
  readonly unresolved_target_ref: string | null;
  readonly type: string;
  readonly asserted_by: string;
  readonly evidence_ref: string;
  readonly algorithm: string | null;
  readonly algorithm_version: string | null;
  readonly recorded_at: string;
}

export interface ObservationRepublication { readonly predecessor_revision_id: string; readonly is_republication: boolean }
