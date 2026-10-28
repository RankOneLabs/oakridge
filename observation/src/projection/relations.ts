import { canonicalDigest } from "../canonical/canonical-json";
import type { LinkReference, RelationType } from "./extractor";

export type Assertion = "producer_explicit" | "human" | "inferred";
export interface RelationProposal {
  readonly source_occurrence_id: string;
  readonly target_occurrence_id: string | null;
  readonly unresolved_target_ref: string | null;
  readonly type: RelationType;
  readonly asserted_by: Assertion;
  readonly evidence_ref: string;
  readonly algorithm: string | null;
  readonly algorithm_version: string | null;
}

export function targetReference(link: LinkReference): string {
  return `${link.target_artifact_kind}:${link.target_item_kind}:${link.target_scope ?? "*"}:${link.target_local_id}`;
}

export function producerRelation(source_occurrence_id: string, link: LinkReference,
  target_occurrence_id: string | null): RelationProposal {
  return { source_occurrence_id, target_occurrence_id,
    unresolved_target_ref: target_occurrence_id === null ? targetReference(link) : null,
    type: link.type, asserted_by: "producer_explicit", evidence_ref: link.evidence_ref,
    algorithm: null, algorithm_version: null };
}

export function relationId(proposal: RelationProposal): string {
  const digest = canonicalDigest([proposal.source_occurrence_id, proposal.type, proposal.asserted_by,
    proposal.evidence_ref, proposal.asserted_by === "human" ? proposal.target_occurrence_id : null]);
  if (!digest.ok) throw new Error("relation identity must be canonical JSON");
  return digest.value;
}

export function humanRelation(source_occurrence_id: string, target_occurrence_id: string,
  type: RelationType, evidence_ref: string): RelationProposal {
  return { source_occurrence_id, target_occurrence_id, unresolved_target_ref: null,
    type, asserted_by: "human", evidence_ref, algorithm: null, algorithm_version: null };
}
