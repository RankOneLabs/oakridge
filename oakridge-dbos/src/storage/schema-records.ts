import type * as Rows from "./generated-records";
import type { AttemptId, CollaborationDeliveryId, CollaborationMessageId, CollaborationThreadId, PoolId, ProjectId, ReviewItemId, RevisionId, RunId, UnitId } from "../domain/primitives";

export type { AttemptId, PoolId, ProjectId, RevisionId, RunId, UnitId } from "../domain/primitives";
export type { CommitReceipt } from "./json-column-types";

/**
 * Authority rows as read with `SELECT *`. Columns, nullability and jsonb types
 * come from generated-records.ts; this layer only names which id columns carry
 * which brand. A brand on a nullable column stays nullable.
 */
type Branded<Row, Ids extends { readonly [Column in keyof Ids]: Column extends keyof Row ? string : never }> =
  Readonly<Omit<Row, keyof Ids> & { readonly [Column in keyof Ids]: Column extends keyof Row ? null extends Row[Column] ? Ids[Column] | null : Ids[Column] : never }>;

/** Generated from the authority.effect_status enum: pending|acknowledged|stop_requested|stopped|failed. */
export type EffectStatus = Rows.effect_status;

export type Version = number;
/** Any authority row that carries optimistic-concurrency state. */
export interface VersionedRecord { readonly id: string; readonly version: Version }

export type DefinitionBundleRecord = Readonly<Rows.DefinitionBundle>;
export type PromptContentRecord = Readonly<Rows.PromptContent>;
export type ProjectRecord = Branded<Rows.Project, { id: ProjectId }>;

export type RunRecord = Branded<Rows.Run, { id: RunId; root_unit_id: UnitId; project_id: ProjectId }>;
export type UnitRecord = Branded<Rows.Unit, { id: UnitId; run_id: RunId; parent_id: UnitId }>;
export type UnitDependencyRecord = Branded<Rows.UnitDependency, { run_id: RunId; unit_id: UnitId; depends_on_id: UnitId }>;

/** Identified by (action_id, seq): one row per worker attempt, not a separate execution entity. */
export type AttemptRecord = Branded<Rows.Attempt, { action_id: AttemptId; run_id: RunId; unit_id: UnitId }>;
export type ArtifactRevisionRecord = Branded<Rows.ArtifactRevision, { id: RevisionId; run_id: RunId; unit_id: UnitId; predecessor_id: RevisionId }>;
export type ReviewDecisionRecord = Branded<Rows.ReviewDecision, { run_id: RunId; unit_id: UnitId; target_revision_id: RevisionId }>;

export type EventRecord = Branded<Rows.Event, { run_id: RunId; unit_id: UnitId }>;
export type WantedLogRecord = Branded<Rows.WantedLog, { run_id: RunId; unit_id: UnitId }>;
export type IngressReceiptRecord = Branded<Rows.IngressReceipt, { run_id: RunId; unit_id: UnitId }>;
export type EffectIntentRecord = Branded<Rows.EffectIntent, { run_id: RunId; unit_id: UnitId; action_id: AttemptId }>;

export type CapacityPoolRecord = Branded<Rows.CapacityPool, { id: PoolId; run_id: RunId }>;
export type CapacityReservationRecord = Branded<Rows.CapacityReservation, { run_id: RunId; pool_id: PoolId; unit_id: UnitId }>;

export type CollaborationThreadRecord = Branded<Rows.CollaborationThread, { id: CollaborationThreadId; run_id: RunId; unit_id: UnitId; artifact_revision_id: RevisionId }>;
export type CollaborationMessageRecord = Branded<Rows.CollaborationMessage, { id: CollaborationMessageId; run_id: RunId; unit_id: UnitId; thread_id: CollaborationThreadId }>;
export type ReviewItemRecord = Branded<Rows.ReviewItem, { id: ReviewItemId; run_id: RunId; unit_id: UnitId; artifact_revision_id: RevisionId; thread_id: CollaborationThreadId }>;
export type CollaborationDeliveryRecord = Branded<Rows.CollaborationDelivery, { id: CollaborationDeliveryId; run_id: RunId; unit_id: UnitId; message_id: CollaborationMessageId }>;

// Wire payloads remain the generated Rust contracts; persistence adds identity and version.
export type { CompiledWorkflow } from "../core-client/core-types";
