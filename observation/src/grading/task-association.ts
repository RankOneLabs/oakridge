import type { ItemOccurrenceId, LogicalItemId } from "../domain/identity";
import { RELATION_SEMANTICS } from "../projection/relations";
import type { CompositeOccurrence, CompositeRelation } from "./composite";

export type AssociationHop = Pick<CompositeRelation, "relation_id" | "type" | "evidence_ref" | "asserted_by">;
export type AssociationProvenance =
  | { readonly kind: "own"; readonly hops: readonly AssociationHop[] }
  | { readonly kind: "relation"; readonly hops: readonly AssociationHop[] };
export interface TaskAssociation { readonly occurrence_id: ItemOccurrenceId; readonly provenance: AssociationProvenance }
export interface TaskAssociationInput {
  readonly task_id: LogicalItemId;
  readonly occurrences: readonly Pick<CompositeOccurrence, "occurrence_id" | "logical_item_id">[];
  readonly relations: readonly CompositeRelation[];
}
const hopOf = ({ relation_id, type, evidence_ref, asserted_by }: CompositeRelation): AssociationHop =>
  ({ relation_id, type, evidence_ref, asserted_by });

/** Multi-source breadth-first traversal. Seeds win over propagated paths; each occurrence is visited once. */
export function associateTask({ task_id, occurrences, relations }: TaskAssociationInput): readonly TaskAssociation[] {
  const present = new Set(occurrences.map((item) => item.occurrence_id));
  const resolved = relations.filter((edge) => edge.unresolved_target_ref === null && present.has(edge.source_occurrence_id));
  const visited = new Set<ItemOccurrenceId>();
  const queue: TaskAssociation[] = [];
  const enqueue = (association: TaskAssociation): void => {
    if (visited.has(association.occurrence_id)) return;
    visited.add(association.occurrence_id);
    queue.push(association);
  };
  for (const item of occurrences) if (item.logical_item_id === task_id)
    enqueue({ occurrence_id: item.occurrence_id, provenance: { kind: "own", hops: [] } });
  for (const edge of resolved) if (edge.target_logical_item_id === task_id && RELATION_SEMANTICS[edge.type].establishes_task_association)
    enqueue({ occurrence_id: edge.source_occurrence_id, provenance: { kind: "relation", hops: [hopOf(edge)] } });
  const incoming = new Map<ItemOccurrenceId, CompositeRelation[]>();
  for (const edge of resolved) if (edge.target_occurrence_id !== null && RELATION_SEMANTICS[edge.type].propagates_task_association) {
    const group = incoming.get(edge.target_occurrence_id) ?? [];
    group.push(edge);
    incoming.set(edge.target_occurrence_id, group);
  }
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const associated = queue[cursor];
    if (!associated) continue;
    for (const edge of incoming.get(associated.occurrence_id) ?? [])
      enqueue({ occurrence_id: edge.source_occurrence_id, provenance: { ...associated.provenance, hops: [...associated.provenance.hops, hopOf(edge)] } });
  }
  return queue;
}
