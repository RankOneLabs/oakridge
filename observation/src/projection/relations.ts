import { canonicalDigest } from "../canonical/canonical-json";
import type { LinkReference, RelationType } from "./extractor";

export type Assertion = "producer_explicit" | "human" | "inferred";
export type RelationEndpoint = { readonly kind: "occurrence" | "logical_item"; readonly id: string };
export type RelationTarget = RelationEndpoint | { readonly kind: "unresolved"; readonly ref: string };
export interface RevisionAnchorIdentity { readonly producer: string; readonly namespace: string;
  readonly run_id: string; readonly artifact_kind: string; readonly revision_id: string }
export interface RelationProposal {
  readonly source: RelationEndpoint;
  readonly target: RelationTarget;
  readonly type: RelationType;
  readonly asserted_by: Assertion;
  readonly evidence_ref: string;
  readonly algorithm: string | null;
  readonly algorithm_version: string | null;
}

export function targetReference(link: LinkReference): string {
  return `${link.target_artifact_kind}:${link.target_item_kind}:${link.target_scope ?? "*"}:${link.target_local_id}`;
}

export function revisionAnchorId(identity: RevisionAnchorIdentity): string {
  return `${identity.producer}:${identity.namespace}:${identity.run_id}:artifact_revision/${identity.artifact_kind}:${identity.revision_id}`;
}

export function producerRelation(source_occurrence_id: string, link: LinkReference,
  target_occurrence_id: string | null): RelationProposal {
  return { source: { kind: "occurrence", id: source_occurrence_id },
    target: target_occurrence_id === null ? { kind: "unresolved", ref: targetReference(link) }
      : { kind: "occurrence", id: target_occurrence_id },
    type: link.type, asserted_by: "producer_explicit", evidence_ref: link.evidence_ref,
    algorithm: null, algorithm_version: null };
}

/** The producer's subject field relates two artifact revisions, represented as logical anchors. */
export function subjectRelation(source_logical_item_id: string, target_logical_item_id: string | null,
  subject_revision_id: string): RelationProposal {
  return { source: { kind: "logical_item", id: source_logical_item_id },
    target: target_logical_item_id === null
      ? { kind: "unresolved", ref: `artifact_revision:build_result:${subject_revision_id}` }
      : { kind: "logical_item", id: target_logical_item_id },
    type: "assesses", asserted_by: "producer_explicit", evidence_ref: "artifact_revision.subject",
    algorithm: null, algorithm_version: null };
}

export function relationId(proposal: RelationProposal): string {
  const humanTarget = proposal.asserted_by === "human" && proposal.target.kind !== "unresolved" ? proposal.target.id : null;
  const tuple = proposal.source.kind === "occurrence"
    ? [proposal.source.id, proposal.type, proposal.asserted_by, proposal.evidence_ref, humanTarget]
    : ["logical_item", proposal.source.id, proposal.type, proposal.asserted_by, proposal.evidence_ref, humanTarget];
  const digest = canonicalDigest(tuple);
  if (!digest.ok) throw new Error("relation identity must be canonical JSON");
  return digest.value;
}

export function humanRelation(source_occurrence_id: string, target_occurrence_id: string,
  type: RelationType, evidence_ref: string): RelationProposal {
  return { source: { kind: "occurrence", id: source_occurrence_id },
    target: { kind: "occurrence", id: target_occurrence_id },
    type, asserted_by: "human", evidence_ref, algorithm: null, algorithm_version: null };
}
