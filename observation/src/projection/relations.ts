import { canonicalDigest } from "canonical-json";
import type { LinkReference, LogicalItemLink, OccurrenceLink, RelationType } from "./extractor";

export type Assertion = "producer_explicit" | "human" | "inferred";
export type RelationEndpoint = { readonly kind: "occurrence" | "logical_item"; readonly id: string };
export type RelationTarget = RelationEndpoint | { readonly kind: "unresolved"; readonly ref: string };
export interface RevisionAnchorIdentity { readonly producer: string; readonly namespace: string;
  readonly run_id: string; readonly artifact_kind: string; readonly revision_id: string }
export interface LogicalItemIdentity { readonly producer: string; readonly namespace: string;
  readonly run_id: string; readonly scope: string; readonly producer_local_id: string }
export interface RelationProposal {
  readonly source: RelationEndpoint;
  readonly target: RelationTarget;
  readonly type: RelationType;
  readonly asserted_by: Assertion;
  readonly evidence_ref: string;
  readonly algorithm: string | null;
  readonly algorithm_version: string | null;
}

/** An explicit link to an item already captured in one run, addressed by its exact revision and path. */
export interface RelationDeclaration {
  readonly run_id: string;
  readonly source_revision_id: string;
  readonly item_path: string;
  readonly link: LogicalItemLink;
}

/** Run-scoped: the same local id in another run is a different logical item. */
export function logicalItemId(identity: LogicalItemIdentity): string {
  return `${identity.producer}:${identity.namespace}:${identity.run_id}:${identity.scope}:${identity.producer_local_id}`;
}

export function logicalReference(scope: string, producer_local_id: string): string {
  return `logical_item:${scope}:${producer_local_id}`;
}

export function targetReference(link: LinkReference): string {
  return link.target === "logical_item" ? logicalReference(link.target_scope, link.target_local_id)
    : `${link.target_artifact_kind}:${link.target_item_kind}:${link.target_scope ?? "*"}:${link.target_local_id}`;
}

export function revisionAnchorId(identity: RevisionAnchorIdentity): string {
  return `${identity.producer}:${identity.namespace}:${identity.run_id}:artifact_revision/${identity.artifact_kind}:${identity.revision_id}`;
}

function producerProposal(source_occurrence_id: string, link: LinkReference, target: RelationTarget): RelationProposal {
  return { source: { kind: "occurrence", id: source_occurrence_id }, target, type: link.type,
    asserted_by: "producer_explicit", evidence_ref: link.evidence_ref, algorithm: null, algorithm_version: null };
}

export function occurrenceRelation(source_occurrence_id: string, link: OccurrenceLink,
  target_occurrence_id: string | null): RelationProposal {
  return producerProposal(source_occurrence_id, link, target_occurrence_id === null
    ? { kind: "unresolved", ref: targetReference(link) } : { kind: "occurrence", id: target_occurrence_id });
}

export function logicalItemRelation(source_occurrence_id: string, link: LogicalItemLink,
  target_logical_item_id: string | null): RelationProposal {
  return producerProposal(source_occurrence_id, link, target_logical_item_id === null
    ? { kind: "unresolved", ref: targetReference(link) } : { kind: "logical_item", id: target_logical_item_id });
}

/** The producer's subject field relates two artifact revisions, represented as logical anchors. */
export function subjectRelation(source_logical_item_id: string, target_logical_item_id: string | null,
  target_artifact_kind: string, subject_revision_id: string): RelationProposal {
  return { source: { kind: "logical_item", id: source_logical_item_id },
    target: target_logical_item_id === null
      ? { kind: "unresolved", ref: `artifact_revision:${target_artifact_kind}:${subject_revision_id}` }
      : { kind: "logical_item", id: target_logical_item_id },
    type: "assesses", asserted_by: "producer_explicit", evidence_ref: "artifact_revision.subject",
    algorithm: null, algorithm_version: null };
}

/** The target stays out of the identity, so a later resolution updates the same relation. */
export function relationId(proposal: RelationProposal): string {
  const tuple = proposal.source.kind === "occurrence"
    ? [proposal.source.id, proposal.type, proposal.asserted_by, proposal.evidence_ref, null]
    : ["logical_item", proposal.source.id, proposal.type, proposal.asserted_by, proposal.evidence_ref, null];
  const digest = canonicalDigest(tuple);
  if (!digest.ok) throw new Error("relation identity must be canonical JSON");
  return digest.value;
}
