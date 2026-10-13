// Generated from src/storage/migrations/0001_core.sql. Run bun oakridge-dbos/scripts/generate-storage-records.ts.
// jsonb column types come from each column's @type comment, resolved in json-column-types.ts.

import type { AttemptStatus, Cause, CollaborationDeliveryPayload, CollaborationMessageBody, CollaborationThreadContext, CommitReceipt, CompiledWorkflow, CoreEvent, DefinitionBundleSource, EffectInstruction, ForgeRepository, JsonColumn, Mode, NullableJsonColumn, OperatorEventPayload, PinnedPrompts, ReviewItemBody, ReviewPrompts, RuntimeValue, SessionPolicy, UnitStatus, WantedActions, Writer } from "./json-column-types";
import type { ColumnType } from "kysely";

export type AuthorityEffectStatus = "acknowledged" | "failed" | "pending" | "stop_requested" | "stopped";

export type Generated<T> = T extends ColumnType<infer S, infer I, infer U>
  ? ColumnType<S, I | undefined, U>
  : ColumnType<T, T | undefined, T>;

export type Timestamp = ColumnType<Date, Date | string, Date | string>;

export interface AuthorityArtifactRevision {
  artifact: string;
  /**
   * @type {RuntimeValue}
   */
  body: JsonColumn<RuntimeValue>;
  by_id: string | null;
  created_at: Generated<Timestamp>;
  id: string;
  predecessor_id: string | null;
  run_id: string;
  subject: string | null;
  unit_id: string;
}

export interface AuthorityAttempt {
  action_id: string;
  /**
   * @type {Cause}
   */
  cause: JsonColumn<Cause>;
  created_at: Generated<Timestamp>;
  ended_at: number | null;
  kbbl_session_id: string | null;
  /**
   * @type {Mode}
   */
  mode: JsonColumn<Mode>;
  publication_secret_hash: string | null;
  run_id: string;
  seq: number;
  /**
   * @type {AttemptStatus}
   */
  status: JsonColumn<AttemptStatus>;
  unit_id: string;
  worker: string;
}

export interface AuthorityCollaborationDelivery {
  created_at: Generated<Timestamp>;
  id: string;
  message_id: string;
  /**
   * @type {CollaborationDeliveryPayload}
   */
  payload: JsonColumn<CollaborationDeliveryPayload>;
  run_id: string;
  unit_id: string;
}

export interface AuthorityCollaborationMessage {
  /**
   * @type {CollaborationMessageBody}
   */
  body: JsonColumn<CollaborationMessageBody>;
  created_at: Generated<Timestamp>;
  id: string;
  run_id: string;
  thread_id: string;
  unit_id: string;
}

export interface AuthorityCollaborationThread {
  artifact_revision_id: string | null;
  /**
   * @type {CollaborationThreadContext}
   */
  context: JsonColumn<CollaborationThreadContext>;
  created_at: Generated<Timestamp>;
  id: string;
  run_id: string;
  unit_id: string;
}

export interface AuthorityDefinitionBundle {
  archived_at: Timestamp | null;
  /**
   * @type {CompiledWorkflow}
   */
  checked_program: JsonColumn<CompiledWorkflow>;
  created_at: Generated<Timestamp>;
  digest: string;
  id: string;
  /**
   * @type {PinnedPrompts}
   */
  prompts: Generated<JsonColumn<PinnedPrompts>>;
  /**
   * @type {DefinitionBundleSource}
   */
  source: JsonColumn<DefinitionBundleSource>;
  version: Generated<number>;
}

export interface AuthorityEffectIntent {
  action_id: string;
  id: string;
  last_error: string | null;
  next_try_at: Timestamp | null;
  /**
   * @type {EffectInstruction}
   */
  payload: JsonColumn<EffectInstruction>;
  run_id: string;
  seq: number;
  status: Generated<AuthorityEffectStatus>;
  tries: Generated<number>;
  unit_id: string;
  updated_at: Generated<Timestamp>;
}

export interface AuthorityEvent {
  commit_txid: Generated<number>;
  created_at: Generated<Timestamp>;
  id: string;
  ingress_id: string | null;
  /**
   * @type {CoreEvent}
   */
  payload: JsonColumn<CoreEvent>;
  run_id: string;
  unit_id: string | null;
  /**
   * @type {Writer}
   */
  writer: JsonColumn<Writer>;
}

export interface AuthorityIngressReceipt {
  id: string;
  ingress_id: string;
  request_digest: string;
  /**
   * @type {CommitReceipt}
   */
  result: JsonColumn<CommitReceipt>;
  run_id: string;
  unit_id: string | null;
}

export interface AuthorityOperatorEvent {
  commit_txid: Generated<number>;
  created_at: Generated<Timestamp>;
  event_key: string;
  id: string;
  /**
   * @type {OperatorEventPayload}
   */
  payload: JsonColumn<OperatorEventPayload>;
  run_id: string | null;
  run_key: string;
}

export interface AuthorityProject {
  created_at: Generated<Timestamp>;
  /**
   * @type {ForgeRepository}
   */
  forge_repository: NullableJsonColumn<ForgeRepository>;
  id: string;
  integration_branch: string | null;
  name: string;
  repo_dir: string;
  /**
   * @type {SessionPolicy}
   */
  session_policy: NullableJsonColumn<SessionPolicy>;
}

export interface AuthorityPromptContent {
  content: string;
  content_digest: string;
}

export interface AuthorityReviewDecision {
  created_at: Generated<Timestamp>;
  decision: string;
  effect: string;
  id: string;
  /**
   * @type {RuntimeValue}
   */
  payload: JsonColumn<RuntimeValue>;
  review: string;
  run_id: string;
  target_revision_id: string;
  unit_id: string;
}

export interface AuthorityReviewItem {
  artifact_revision_id: string | null;
  /**
   * @type {ReviewItemBody}
   */
  body: JsonColumn<ReviewItemBody>;
  created_at: Generated<Timestamp>;
  id: string;
  run_id: string;
  thread_id: string | null;
  unit_id: string;
}

export interface AuthorityRun {
  archived_at: Timestamp | null;
  created_at: Generated<Timestamp>;
  definition_bundle_id: string;
  id: string;
  /**
   * @type {RuntimeValue}
   */
  input: NullableJsonColumn<RuntimeValue>;
  project_id: string | null;
  root_unit_id: string | null;
  /**
   * @type {UnitStatus}
   */
  status: Generated<JsonColumn<UnitStatus>>;
  version: Generated<number>;
}

export interface AuthorityUnit {
  collection_key: string | null;
  declaration: string;
  id: string;
  /**
   * @type {RuntimeValue}
   */
  input: JsonColumn<RuntimeValue>;
  parent_id: string | null;
  pool: string | null;
  /**
   * @type {ReviewPrompts}
   */
  review_prompts: Generated<JsonColumn<ReviewPrompts>>;
  run_id: string;
  stage: string | null;
  /**
   * @type {UnitStatus}
   */
  status: JsonColumn<UnitStatus>;
  unit_key: string;
  version: Generated<number>;
}

export interface AuthorityUnitDependency {
  depends_on_id: string;
  run_id: string;
  unit_id: string;
}

export interface AuthorityWantedLog {
  /**
   * @type {WantedActions}
   */
  actions: JsonColumn<WantedActions>;
  event_id: string;
  id: string;
  run_id: string;
  unit_id: string;
}

export interface DB {
  "authority.artifact_revision": AuthorityArtifactRevision;
  "authority.attempt": AuthorityAttempt;
  "authority.collaboration_delivery": AuthorityCollaborationDelivery;
  "authority.collaboration_message": AuthorityCollaborationMessage;
  "authority.collaboration_thread": AuthorityCollaborationThread;
  "authority.definition_bundle": AuthorityDefinitionBundle;
  "authority.effect_intent": AuthorityEffectIntent;
  "authority.event": AuthorityEvent;
  "authority.ingress_receipt": AuthorityIngressReceipt;
  "authority.operator_event": AuthorityOperatorEvent;
  "authority.project": AuthorityProject;
  "authority.prompt_content": AuthorityPromptContent;
  "authority.review_decision": AuthorityReviewDecision;
  "authority.review_item": AuthorityReviewItem;
  "authority.run": AuthorityRun;
  "authority.unit": AuthorityUnit;
  "authority.unit_dependency": AuthorityUnitDependency;
  "authority.wanted_log": AuthorityWantedLog;
}
