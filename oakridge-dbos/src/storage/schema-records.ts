import type { Selectable } from "kysely";
import type { DB } from "./db-types";
import type { ActionId, CollaborationDeliveryId, CollaborationMessageId, CollaborationThreadId, DecisionId, DefinitionBundleId, EffectIntentId, EventId, OperatorEventId, ProjectId, ReviewItemId, RevisionId, RunId, UnitId } from "../domain/primitives";

export type { ActionId, DecisionId, DefinitionBundleId, EffectIntentId, EventId, ProjectId, RevisionId, RunId, UnitId } from "../domain/primitives";
export type { CommitReceipt } from "./json-column-types";

/**
 * Authority rows as selected. Columns, nullability and jsonb types come from
 * the generated db-types.ts; this layer only names which id columns carry
 * which brand. A brand on a nullable column stays nullable.
 */
type Branded<Row, Ids extends { readonly [Column in keyof Ids]: Column extends keyof Row ? string : never }> =
  Readonly<Omit<Row, keyof Ids> & { readonly [Column in keyof Ids]: Column extends keyof Row ? null extends Row[Column] ? Ids[Column] | null : Ids[Column] : never }>;
type Row<Table extends keyof DB> = Selectable<DB[Table]>;

/** Generated from the authority.effect_status enum. */
export type EffectStatus = Row<"authority.effect_intent">["status"];

export type DefinitionBundleRecord = Branded<Row<"authority.definition_bundle">, { id: DefinitionBundleId }>;
export type PromptContentRecord = Readonly<Row<"authority.prompt_content">>;
export type ProjectRecord = Branded<Row<"authority.project">, { id: ProjectId }>;
export type RunRecord = Branded<Row<"authority.run">, { id: RunId; definition_bundle_id: DefinitionBundleId; project_id: ProjectId; root_unit_id: UnitId }>;
export type UnitRecord = Branded<Row<"authority.unit">, { id: UnitId; run_id: RunId; parent_id: UnitId }>;
export type UnitDependencyRecord = Branded<Row<"authority.unit_dependency">, { run_id: RunId; unit_id: UnitId; depends_on_id: UnitId }>;
export type AttemptRecord = Branded<Row<"authority.attempt">, { action_id: ActionId; run_id: RunId; unit_id: UnitId }>;
export type ArtifactRevisionRecord = Branded<Row<"authority.artifact_revision">, { id: RevisionId; run_id: RunId; unit_id: UnitId; by_id: ActionId; predecessor_id: RevisionId; subject: RevisionId }>;
export type ReviewDecisionRecord = Branded<Row<"authority.review_decision">, { id: DecisionId; run_id: RunId; unit_id: UnitId; target_revision_id: RevisionId }>;
export type EventRecord = Branded<Row<"authority.event">, { id: EventId; run_id: RunId; unit_id: UnitId }>;
export type WantedLogRecord = Branded<Row<"authority.wanted_log">, { run_id: RunId; unit_id: UnitId; event_id: EventId }>;
export type EffectIntentRecord = Branded<Row<"authority.effect_intent">, { id: EffectIntentId; run_id: RunId; unit_id: UnitId; action_id: ActionId }>;
export type IngressReceiptRecord = Branded<Row<"authority.ingress_receipt">, { run_id: RunId; unit_id: UnitId }>;
export type OperatorEventRecord = Branded<Row<"authority.operator_event">, { id: OperatorEventId; run_id: RunId }>;
export type CollaborationThreadRecord = Branded<Row<"authority.collaboration_thread">, { id: CollaborationThreadId; run_id: RunId; unit_id: UnitId; artifact_revision_id: RevisionId }>;
export type CollaborationMessageRecord = Branded<Row<"authority.collaboration_message">, { id: CollaborationMessageId; run_id: RunId; unit_id: UnitId; thread_id: CollaborationThreadId }>;
export type ReviewItemRecord = Branded<Row<"authority.review_item">, { id: ReviewItemId; run_id: RunId; unit_id: UnitId; artifact_revision_id: RevisionId; thread_id: CollaborationThreadId }>;
export type CollaborationDeliveryRecord = Branded<Row<"authority.collaboration_delivery">, { id: CollaborationDeliveryId; run_id: RunId; unit_id: UnitId; message_id: CollaborationMessageId }>;
