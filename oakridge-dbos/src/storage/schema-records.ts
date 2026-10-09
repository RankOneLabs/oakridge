import type * as Rows from "./generated-records";
import type { CollaborationDeliveryId, CollaborationMessageId, CollaborationThreadId, ExecutionId, OperatorEventId, PoolId, ProjectId, RevisionId, ReviewItemId, RunId, RunTransitionId, ScopeId } from "../domain/primitives";
import type { Materialization } from "../core-client/generated-contracts";

export type { CollaborationDeliveryId, CollaborationMessageId, CollaborationThreadId, ExecutionId, OperatorEventId, PoolId, ProjectId, RevisionId, ReviewItemId, RunId, RunTransitionId, ScopeId } from "../domain/primitives";
export type { ChildCollectionMember, CommitReceipt } from "./json-column-types";

/**
 * Authority rows as read with `SELECT *`. Columns, nullability and jsonb types
 * come from generated-records.ts; this layer only names which id columns carry
 * which brand. A brand on a nullable column stays nullable.
 */
type Branded<Row, Ids extends { readonly [Column in keyof Ids]: Column extends keyof Row ? string : never }> =
  Readonly<Omit<Row, keyof Ids> & { readonly [Column in keyof Ids]: Column extends keyof Row ? null extends Row[Column] ? Ids[Column] | null : Ids[Column] : never }>;

/** Generated from the authority.effect_status and authority.execution_status enums. */
export type EffectStatus = Rows.effect_status;
export type ExecutionStatus = Rows.execution_status;

export type Version = number;
/** Any authority row that carries optimistic-concurrency state. */
export interface VersionedRecord { readonly id: string; readonly version: Version }

export type DefinitionBundleRecord = Readonly<Rows.DefinitionBundle>;
export type OperatorEventRecord = Branded<Rows.OperatorEvent, { id: OperatorEventId; run_id: RunId; scope_id: ScopeId }>;
export type CollaborationThreadRecord = Branded<Rows.CollaborationThread, { id: CollaborationThreadId; run_id: RunId; scope_id: ScopeId; revision_id: RevisionId }>;
export type CollaborationMessageRecord = Branded<Rows.CollaborationMessage, { id: CollaborationMessageId; thread_id: CollaborationThreadId }>;
export type ReviewItemRecord = Branded<Rows.ReviewItem, { id: ReviewItemId; run_id: RunId; scope_id: ScopeId; revision_id: RevisionId }>;
export type CollaborationDeliveryRecord = Branded<Rows.CollaborationDelivery, { id: CollaborationDeliveryId; thread_id: CollaborationThreadId; target_execution_id: ExecutionId }>;
export type PromptContentRecord = Readonly<Rows.PromptContent>;
export type RunRecord = Branded<Rows.Run, { id: RunId; project_id: ProjectId }>;
export type LaunchReceiptRecord = Branded<Rows.LaunchReceipt, { run_id: RunId; root_scope_id: ScopeId }>;
export type ScopeInstanceRecord = Branded<Rows.ScopeInstance, { id: ScopeId; run_id: RunId; parent_id: ScopeId }>;
export type ScopeExportRecord = Branded<Rows.ScopeExport, { run_id: RunId; scope_id: ScopeId }>;
export type ChildCollectionRecord = Branded<Rows.ChildCollection, { run_id: RunId; scope_id: ScopeId }>;
export type ExecutionSelectionRecord = Branded<Rows.ExecutionSelection, { run_id: RunId; scope_id: ScopeId; execution_id: ExecutionId }>;
export type ExecutionRecord = Branded<Rows.Execution, { id: ExecutionId; run_id: RunId; scope_id: ScopeId }>;
export type ArtifactRevisionRecord = Branded<Rows.ArtifactRevision, { id: RevisionId; run_id: RunId; scope_id: ScopeId; execution_id: ExecutionId; predecessor_id: RevisionId }>;
export type OutputSlotRecord = Branded<Rows.OutputSlot, { run_id: RunId; scope_id: ScopeId; current_revision_id: RevisionId }>;
export type FactRecord = Branded<Rows.Fact, { run_id: RunId; scope_id: ScopeId }>;
export type TransitionRecord = Branded<Rows.Transition, { run_id: RunId; scope_id: ScopeId }>;
export type IngressReceiptRecord = Branded<Rows.IngressReceipt, { run_id: RunId; scope_id: ScopeId }>;
export type EffectIntentRecord = Branded<Rows.EffectIntent, { run_id: RunId; scope_id: ScopeId; execution_id: ExecutionId }>;
export type CapacityPoolRecord = Branded<Rows.CapacityPool, { id: PoolId; run_id: RunId }>;
export type CapacityReservationRecord = Branded<Rows.CapacityReservation, { run_id: RunId; pool_id: PoolId; scope_id: ScopeId }>;
export type ResourceBindingRecord = Branded<Rows.ResourceBinding, { run_id: RunId; scope_id: ScopeId }>;
export type ProjectRecord = Branded<Rows.Project, { id: ProjectId }>;

/** Authorship follows immutable revision evidence and its publishing transition. */
export type RevisionAuthorship =
  | { readonly kind: "agent"; readonly execution_id: ExecutionId }
  | { readonly kind: "operator"; readonly transition_id: RunTransitionId; readonly request_id: string };

// Wire payloads remain the generated Rust contracts; persistence adds identity and version.
export type CompiledBundle = import("../core-client/generated-contracts").CompiledBundle;
export type MaterializedCollection = Materialization;
