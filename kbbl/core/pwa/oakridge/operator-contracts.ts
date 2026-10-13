// Generated from oakridge-dbos/src/http/operator-api.ts. Run bun kbbl/scripts/generate-operator-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

export interface OperatorRunPage { readonly items: readonly OperatorRunView[]; readonly next_cursor: string | null }

export interface OperatorRunView extends OperatorRunSummary {
  readonly cursor: readonly { readonly unit_id: string; readonly version: number }[];
  readonly units: readonly OperatorRunUnitSummary[];
}

export interface OperatorRunSummary {
  readonly run_id: string; readonly definition_bundle_id: string; readonly definition_digest: string; readonly version: number;
  readonly created_at: string; readonly archived_at: string | null;
  /** The root unit's status. */
  readonly status: OperatorUnitStatus;
}

export type OperatorRunDetail = OperatorRunView;

export interface OperatorRunUnitSummary {
  readonly unit_id: string;
  readonly unit_key: string;
  readonly label: string;
  readonly version: number;
  readonly is_terminal: boolean;
  /** Keys of the decisions that ask for the operator now (not the run's cancel). */
  readonly available_decisions: readonly string[];
  readonly stage: string | null;
  readonly status: OperatorUnitStatus;
}

export interface OperatorRunInspectView {
  readonly run_id: string;
  readonly status: OperatorUnitStatus;
  readonly units: readonly { readonly id: string; readonly unit_key: string; readonly label: string; readonly stage: string | null; readonly status: OperatorUnitStatus }[];
  readonly attention: readonly OperatorInspectAttention[];
  readonly artifacts: readonly OperatorArtifactView[];
  readonly attempts: readonly OperatorAttemptView[];
  /** Newest first. */
  readonly events: readonly OperatorInspectEvent[];
}

export type OperatorInspectAttention =
  | { readonly kind: "stalled_worker"; readonly unit_id: string; readonly worker: string; readonly action_id: string; readonly detail: string;
    readonly decisions: readonly OperatorDecisionDefinition[] }
  | { readonly kind: "awaiting_review"; readonly unit_id: string; readonly review: string; readonly target: string;
    readonly decisions: readonly OperatorDecisionDefinition[] };

export interface OperatorDefinitionPage { readonly items: readonly OperatorDefinitionSummary[]; readonly next_cursor: string | null }

export interface OperatorDefinitionSummary { readonly bundle_id: string; readonly digest: string; readonly source: OperatorDefinitionBundle; readonly archived_at: string | null }

export interface OperatorDefinitionDetail extends OperatorDefinitionSummary { readonly graph: OperatorDefinitionGraph }

export interface OperatorPinnedDefinition extends OperatorDefinitionSummary { readonly checked_program: OperatorCompiledWorkflow }

export interface OperatorUnitView {
  readonly unit_id: string;
  readonly run_id: string;
  readonly unit_key: string;
  readonly label: string;
  readonly stage: string | null;
  readonly collection_key: string | null;
  readonly input: OperatorBodyValue;
  readonly depends_on: readonly string[];
  /** v1's scope state: the unit's status. */
  readonly state: OperatorUnitStatus;
  readonly outcome: OperatorBodyValue | null;
  readonly is_terminal: boolean;
  readonly decisions: readonly OperatorDecisionDefinition[];
  readonly attempts: readonly OperatorAttemptView[];
  readonly artifacts: readonly OperatorArtifactView[];
  readonly decision_targets: Readonly<{ readonly [decision_key: string]: readonly OperatorTargetRevision[] }>;
  readonly decision_prefill: Readonly<{ readonly [decision_key: string]: OperatorDecisionPrefill }>;
  /** Derived attention under its v1 name (R4 decision, part 1 §12). */
  readonly decision: OperatorAttention | null;
  readonly cursor: OperatorUnitCursor;
}

export interface OperatorDecision { readonly decision: OperatorAttention | null; readonly cursor: OperatorUnitCursor }

export type OperatorInboxItem =
  | { readonly kind: "decision"; readonly run_id: string; readonly unit_id: string; readonly unit_version: number; readonly key: string;
    readonly label: string; readonly consequence: string; readonly submit: OperatorDecisionSubmit;
    /** The awaiting review's prompt, rendered with its resolved inputs; null for a retry. */
    readonly prompt: string | null }
  | { readonly kind: "wait"; readonly run_id: string; readonly unit_id: string; readonly unit_version: number; readonly reason: string; readonly label: string }
  | { readonly kind: "diagnostic"; readonly run_id: string; readonly unit_id: string; readonly unit_version: number; readonly detail: string };

export interface OperatorInboxPage {
  readonly cursor: readonly { readonly unit_id: string; readonly version: number }[];
  readonly items: readonly OperatorInboxItem[];
  readonly next_cursor: string | null;
}

export type OperatorReviewInbox = OperatorInboxPage;

export interface OperatorSessionLocation {
  readonly run_id: string;
  readonly unit_id: string;
  readonly attempt_id: string;
}

export interface OperatorRunSessionAttempt {
  readonly location: OperatorSessionLocation;
  readonly worker_key: string;
  readonly generation: number;
  readonly status: OperatorAttemptView["status"];
  readonly result: OperatorAttemptView["result"];
}

export interface OperatorArtifactDetail {
  readonly run_id: string;
  readonly unit_id: string;
  readonly artifact_key: string;
  readonly collection_key: string;
  /** How many revisions the artifact has. */
  readonly artifact_version: number;
  readonly revision_id: string | null;
  readonly predecessor_id: string | null;
  readonly body: OperatorBodyValue | null;
  /** Of the latest revision: its latest decision's effect, or draft while it has none. */
  readonly status: OperatorArtifactRevisionStatus;
  readonly schema: string;
  readonly reviewable: boolean;
  /** Oldest first. */
  readonly revisions: readonly OperatorArtifactRevisionView[];
  readonly decisions: readonly OperatorRevisionDecision[];
}

export type OperatorArtifactRevisionStatus = "draft" | "approved" | "rejected";

export interface OperatorUnitHistory { readonly unit_id: string; readonly events: readonly OperatorEventHistory[]; readonly next_cursor: string | null }

export interface OperatorUnitDiagnostics {
  readonly unit_id: string;
  readonly unit_version: number;
  readonly attempts: readonly OperatorAttemptView[];
  readonly effects: readonly OperatorEffectDiagnostic[];
  /** Events step refused for this unit. */
  readonly rejected: readonly OperatorRejectedEvent[];
}

export interface OperatorCollaborationThreadView {
  readonly id: string;
  readonly run_id: string;
  readonly unit_id: string;
  readonly artifact_revision_id: string;
  readonly context: OperatorCollaborationThreadRow["context"];
  readonly created_at: string;
  readonly capabilities: { readonly can_write: boolean };
  readonly messages: readonly OperatorCollaborationMessageRow[];
  readonly review_items: readonly OperatorReviewItemRow[];
  readonly deliveries: readonly OperatorCollaborationDeliveryRecord[];
  readonly last_delivery_failure_reason: string | null;
}

export interface OperatorProjectDraft {
  readonly name: string;
  readonly repo_dir: string;
  readonly forge_repository: OperatorForgeRepository | null;
  readonly integration_branch: string | null;
}

export interface OperatorProjectList { readonly items: readonly OperatorProjectView[] }

export type OperatorProjectView = OperatorProjectRecord;

export interface OperatorRunEvent {
  readonly event_id: string;
  readonly run_id: string;
  readonly unit_id: string;
  readonly unit_key: string;
  /** `wait` when the event left a review awaiting the operator, otherwise `apply`. */
  readonly decision: "apply" | "wait";
  readonly attention: OperatorAttentionMetadata | null;
  /** The addressed unit is done or cancelled. */
  readonly is_terminal: boolean;
  /** ISO-8601, as the event log recorded it. */
  readonly occurred_at: string;
  readonly kind: OperatorEvent["kind"];
  readonly run_status: OperatorUnitStatus["kind"];
}

export interface OperatorIngressRequest { readonly request_id: string }

export interface OperatorLaunchRequest extends OperatorIngressRequest { readonly digest: string; readonly input: unknown; readonly project_id?: string | null }

export interface OperatorDecideRequest extends OperatorIngressRequest { readonly decision: string; readonly target: string; readonly payload: unknown }

export type OperatorIngressResponse =
  | { readonly run_id: string; readonly event_id: string }
  | { readonly kind: "rejected"; readonly reason: string }
  | { readonly kind: "conflict"; readonly detail: string };

export type OperatorUnitStatus = { readonly "kind": "not_started" } | { readonly "kind": "active" } | { readonly "kind": "blocked"; readonly "reason": OperatorBlockedReason } | { readonly "kind": "done"; readonly "outcome": unknown } | { readonly "kind": "cancelled" };

export interface OperatorArtifactView {
  /** `<unit id>:<artifact key>`. */
  readonly id: string;
  readonly run_id: string;
  readonly unit_id: string;
  readonly artifact_key: string;
  readonly collection_key: string;
  readonly latest_revision_id: string | null;
  /** How many revisions the artifact has. */
  readonly version: number;
  readonly latest_revision: OperatorArtifactRevisionView | null;
  /** The resolved schema name the PWA's viewer registry dispatches on (§3.1). */
  readonly schema: string;
  /** A review of this artifact is declared (§3.1). */
  readonly reviewable: boolean;
}

export interface OperatorAttemptView {
  /** Opaque: `<action id>:<seq>`. Show the worker, mode and cause instead. */
  readonly id: string;
  readonly unit_id: string;
  readonly worker_key: string;
  /** The attempt's position among its worker's attempts on the unit, from 1, in the order commit opened them. */
  readonly generation: number;
  readonly status: OperatorAttemptStatusKind;
  readonly result: OperatorAttemptFailure | null;
  /** The attempt's seq within its action (a periodic worker's attempts share one action). */
  readonly version: number;
  readonly mode: OperatorMode["kind"];
  readonly cause: OperatorCause;
  readonly kbbl_session_id: string | null;
  readonly created_at: string;
  /** The worker's latest attempt; earlier ones are superseded. */
  readonly is_current: boolean;
}

export interface OperatorInspectEvent { readonly id: string; readonly unit_id: string | null; readonly kind: string; readonly writer: OperatorWriter; readonly created_at: string }

export interface OperatorDecisionDefinition {
  /** Unique within the unit: the decision key, `<review>:<decision>` where a stage reuses a key across reviews, `retry:<worker>`, or `cancel`. */
  readonly key: string;
  readonly label: string;
  readonly consequence: string;
  readonly payload_schema: string;
  readonly targets: readonly OperatorDecisionTarget[];
  /** v2 decisions declare no prefill; the target revision rides in `decision_targets`. */
  readonly prefill: readonly { readonly key: string }[];
  readonly field_presentation: readonly OperatorDecisionFieldPresentation[];
  readonly submit: OperatorDecisionSubmit;
}

export interface OperatorDefinitionBundle {
  readonly key: string;
  readonly version: number;
  /** The root unit's key, as the run view lists it. */
  readonly root: string;
  readonly schemas: readonly OperatorSchema[];
  readonly units: readonly OperatorUnitDefinition[];
}

export interface OperatorDefinitionGraph { readonly nodes: readonly OperatorDefinitionGraphNode[]; readonly edges: readonly { readonly from: string; readonly to: string }[] }

export type OperatorCompiledWorkflow = { readonly "digest": string; readonly "stages": (string)[] };

export type OperatorBodyValue = OperatorJsonValue;

export interface OperatorTargetRevision { readonly identity: string; readonly version: number }

export type OperatorDecisionPrefill = Readonly<{ readonly [field_key: string]: OperatorBodyValue }>;

export type OperatorAttention = { readonly kind: "wait"; readonly reason: string } | { readonly kind: "reject"; readonly error: string };

export interface OperatorUnitCursor { readonly unit_version: number }

export type OperatorDecisionSubmit =
  | { readonly kind: "review"; readonly review: string }
  | { readonly kind: "retry"; readonly worker: string }
  | { readonly kind: "cancel" };

export interface OperatorArtifactRevisionView {
  readonly id: string;
  readonly run_id: string;
  readonly unit_id: string;
  /** The action whose attempt published it; null for an operator's edit (D2). */
  readonly attempt_id: string | null;
  readonly artifact_key: string;
  /** Every v2 artifact is single per unit: always "". */
  readonly collection_key: string;
  readonly body: OperatorBodyValue;
  readonly predecessor_id: string | null;
  /** The revision a review artifact reviews. */
  readonly subject_id: string | null;
  readonly created_at: string;
  /** The revision's position in its artifact, from 1. */
  readonly version: number;
}

export interface OperatorRevisionDecision {
  readonly id: string;
  readonly review: string;
  readonly decision: string;
  readonly effect: OperatorDecisionEffect;
  readonly target_revision_id: string;
  readonly payload: OperatorBodyValue;
  readonly created_at: string;
}

export interface OperatorEventHistory {
  readonly id: string;
  /** The ingress id the event was committed under; null for an event with none. */
  readonly trigger_id: string | null;
  /** What happened: the event itself (v1's evaluator outcome has no v2 source). */
  readonly decision: OperatorEvent;
  readonly writer: OperatorWriter;
  readonly created_at: string;
  /** The writing transaction's id: increases with commit order. */
  readonly version: number;
}

export interface OperatorEffectDiagnostic {
  readonly id: string;
  /** The intent's action id. */
  readonly effect_key: string;
  readonly seq: number;
  readonly status: OperatorIntentStanding["status"];
  readonly tries: number;
  readonly next_try_at: string | null;
  readonly last_error: string | null;
  readonly updated_at: string;
}

export interface OperatorRejectedEvent { readonly ingress_id: string; readonly reason: string }

export interface OperatorCollaborationThreadRow {
  readonly id: string; readonly run_id: string; readonly unit_id: string;
  readonly artifact_revision_id: string; readonly context: OperatorCollaborationThreadContext;
  readonly created_at: string;
}

export interface OperatorCollaborationMessageRow {
  readonly id: string; readonly run_id: string; readonly unit_id: string;
  readonly thread_id: string; readonly body: OperatorCollaborationMessageBody; readonly created_at: string;
}

export interface OperatorReviewItemRow {
  readonly id: string; readonly run_id: string; readonly unit_id: string;
  readonly thread_id: string; readonly artifact_revision_id: string;
  readonly body: OperatorReviewItemBody; readonly created_at: string;
}

export interface OperatorCollaborationDeliveryRecord {
  readonly id: string; readonly run_id: string; readonly unit_id: string; readonly message_id: string;
  readonly payload: OperatorCollaborationDeliveryPayload;
  readonly created_at: string;
}

export interface OperatorForgeRepository { readonly provider: "github"; readonly owner: string; readonly name: string }

export type OperatorProjectRecord = OperatorBranded<OperatorRow<"authority.project">, { id: string }>;

export interface OperatorAttentionMetadata { readonly label: string; readonly trigger: string }

export type OperatorEvent = { readonly "input": unknown; readonly "kind": "launched" } | { readonly "action": string; readonly "kbbl_session_id"?: string | null; readonly "kind": "worker_started" } | { readonly "action": string; readonly "kind": "worker_ended"; readonly "result": OperatorWorkerResult } | { readonly "artifact": string; readonly "body": unknown; readonly "by"?: string | null; readonly "kind": "revision_published"; readonly "predecessor"?: string | null; readonly "subject"?: string | null; readonly "unit": string } | { readonly "decision": string; readonly "kind": "operator_decided"; readonly "payload": unknown; readonly "review": string; readonly "target": string; readonly "unit": string } | { readonly "kind": "retry_requested"; readonly "unit": string; readonly "worker": string } | { readonly "kind": "cancel_requested" };

export type OperatorBlockedReason = { readonly "kind": "waiting_on"; readonly "units": (string)[] } | { readonly "kind": "capacity"; readonly "pool": string };

export type OperatorAttemptStatusKind = OperatorAttemptRecord["status"]["kind"];

export interface OperatorAttemptFailure { readonly code: string; readonly detail: string }

export type OperatorMode = { readonly "kind": "initial" } | { readonly "kind": "revise" } | { readonly "kind": "review" };

export type OperatorCause = { readonly "kind": "missing" } | { readonly "decision": string; readonly "kind": "changes_requested" } | { readonly "kind": "review_of"; readonly "revision": string } | { readonly "event": string; readonly "kind": "retry" } | { readonly "kind": "periodic" };

export type OperatorWriter = { readonly "attempt": string; readonly "kind": "session"; readonly "session": string } | { readonly "attempt": string; readonly "kind": "executor" } | { readonly "kind": "operator"; readonly "subject": string } | { readonly "kind": "engine" };

export interface OperatorDecisionTarget { readonly kind: "reference"; readonly root: { readonly kind: "artifact"; readonly key: string }; readonly path: readonly string[] }

export interface OperatorDecisionFieldPresentation { readonly key: string; readonly presentation: { readonly label: string } }

export interface OperatorSchema { readonly key: string; readonly shape: OperatorSchemaShape }

export interface OperatorUnitDefinition {
  readonly key: string;
  readonly input_schema: string;
  readonly presentation: { readonly label: string };
  readonly artifacts: readonly OperatorArtifactDefinition[];
}

export interface OperatorDefinitionGraphNode { readonly key: string; readonly scope: string; readonly depends_on: readonly string[] }

export type OperatorJsonValue = OperatorJsonPrimitive | readonly OperatorJsonValue[] | { readonly [key: string]: OperatorJsonValue };

export type OperatorDecisionEffect = "approve" | "request_changes";

export type OperatorIntentStanding = Pick<OperatorEffectIntentRecord, "id" | "action_id" | "seq" | "status" | "tries" | "next_try_at" | "last_error" | "updated_at">;

export interface OperatorCollaborationThreadContext { readonly title: string; readonly anchor: string | null }

export interface OperatorCollaborationMessageBody { readonly text: string; readonly author: string; readonly ping?: boolean }

export interface OperatorReviewItemBody { readonly title: string; readonly detail: string; readonly status: string }

export type OperatorCollaborationDeliveryPayload =
  | { readonly status: "delivered"; readonly session_id: string; readonly reason: null; readonly request_key: string }
  | { readonly status: "failed"; readonly session_id: null; readonly reason: string; readonly request_key: string };

export type OperatorBranded<Row, Ids extends { readonly [Column in keyof Ids]: Column extends keyof Row ? string : never }> =
  Readonly<Omit<Row, keyof Ids> & { readonly [Column in keyof Ids]: Column extends keyof Row ? null extends Row[Column] ? Ids[Column] | null : Ids[Column] : never }>;

export type OperatorRow<Table extends keyof OperatorDB> = Selectable<OperatorDB[Table]>;

export type OperatorWorkerResult = { readonly "kind": "succeeded" } | { readonly "code": string; readonly "detail": string; readonly "kind": "failed" };

export type OperatorAttemptRecord = OperatorBranded<OperatorRow<"authority.attempt">, { action_id: string; run_id: string; unit_id: string }>;

export type OperatorSchemaShape =
  | { readonly kind: "boolean" }
  | { readonly kind: "integer"; readonly min: number; readonly max: number }
  | { readonly kind: "string"; readonly min_length: number; readonly max_length: number }
  | { readonly kind: "enum"; readonly variants: readonly string[] }
  | { readonly kind: "record"; readonly fields: readonly OperatorSchemaField[] }
  | { readonly kind: "list"; readonly item: string; readonly max_items: number }
  | { readonly kind: "optional"; readonly item: string };

export interface OperatorArtifactDefinition {
  readonly key: string;
  readonly schema: string;
  /** Every v2 artifact is single per unit. */
  readonly collection_key: string | null;
  /** Operator edits (D2) have no route yet: null hides the edit entry point. */
  readonly edit_trigger: string | null;
}

export type OperatorJsonPrimitive = string | number | boolean | null;

export type OperatorEffectIntentRecord = OperatorBranded<OperatorRow<"authority.effect_intent">, { id: string; run_id: string; unit_id: string; action_id: string }>;

export interface OperatorDB {
  "authority.artifact_revision": OperatorAuthorityArtifactRevision;
  "authority.attempt": OperatorAuthorityAttempt;
  "authority.collaboration_delivery": OperatorAuthorityCollaborationDelivery;
  "authority.collaboration_message": OperatorAuthorityCollaborationMessage;
  "authority.collaboration_thread": OperatorAuthorityCollaborationThread;
  "authority.definition_bundle": OperatorAuthorityDefinitionBundle;
  "authority.effect_intent": OperatorAuthorityEffectIntent;
  "authority.event": OperatorAuthorityEvent;
  "authority.ingress_receipt": OperatorAuthorityIngressReceipt;
  "authority.operator_event": OperatorAuthorityOperatorEvent;
  "authority.project": OperatorAuthorityProject;
  "authority.prompt_content": OperatorAuthorityPromptContent;
  "authority.review_decision": OperatorAuthorityReviewDecision;
  "authority.review_item": OperatorAuthorityReviewItem;
  "authority.run": OperatorAuthorityRun;
  "authority.unit": OperatorAuthorityUnit;
  "authority.unit_dependency": OperatorAuthorityUnitDependency;
  "authority.wanted_log": OperatorAuthorityWantedLog;
}

export interface OperatorSchemaField { readonly key: string; readonly required: boolean; readonly schema: string }

export interface OperatorAuthorityArtifactRevision {
  artifact: string;
  /**
   * @type {RuntimeValue}
   */
  body: OperatorJsonColumn<OperatorRuntimeValue>;
  by_id: string | null;
  created_at: OperatorGenerated<OperatorTimestamp>;
  id: string;
  predecessor_id: string | null;
  run_id: string;
  subject: string | null;
  unit_id: string;
}

export interface OperatorAuthorityAttempt {
  action_id: string;
  /**
   * @type {Cause}
   */
  cause: OperatorJsonColumn<OperatorCause>;
  created_at: OperatorGenerated<OperatorTimestamp>;
  ended_at: number | null;
  kbbl_session_id: string | null;
  /**
   * @type {Mode}
   */
  mode: OperatorJsonColumn<OperatorMode>;
  publication_secret_hash: string | null;
  run_id: string;
  seq: number;
  /**
   * @type {AttemptStatus}
   */
  status: OperatorJsonColumn<OperatorAttemptStatus>;
  unit_id: string;
  worker: string;
}

export interface OperatorAuthorityCollaborationDelivery {
  created_at: OperatorGenerated<OperatorTimestamp>;
  id: string;
  message_id: string;
  /**
   * @type {CollaborationDeliveryPayload}
   */
  payload: OperatorJsonColumn<OperatorCollaborationDeliveryPayload>;
  run_id: string;
  unit_id: string;
}

export interface OperatorAuthorityCollaborationMessage {
  /**
   * @type {CollaborationMessageBody}
   */
  body: OperatorJsonColumn<OperatorCollaborationMessageBody>;
  created_at: OperatorGenerated<OperatorTimestamp>;
  id: string;
  run_id: string;
  thread_id: string;
  unit_id: string;
}

export interface OperatorAuthorityCollaborationThread {
  artifact_revision_id: string | null;
  /**
   * @type {CollaborationThreadContext}
   */
  context: OperatorJsonColumn<OperatorCollaborationThreadContext>;
  created_at: OperatorGenerated<OperatorTimestamp>;
  id: string;
  run_id: string;
  unit_id: string;
}

export interface OperatorAuthorityDefinitionBundle {
  archived_at: OperatorTimestamp | null;
  /**
   * @type {CompiledWorkflow}
   */
  checked_program: OperatorJsonColumn<OperatorCompiledWorkflow>;
  created_at: OperatorGenerated<OperatorTimestamp>;
  digest: string;
  id: string;
  /**
   * @type {PinnedPrompts}
   */
  prompts: OperatorGenerated<OperatorJsonColumn<OperatorPinnedPrompts>>;
  /**
   * @type {DefinitionBundleSource}
   */
  source: OperatorJsonColumn<OperatorDefinitionBundleSource>;
  version: OperatorGenerated<number>;
}

export interface OperatorAuthorityEffectIntent {
  action_id: string;
  id: string;
  last_error: string | null;
  next_try_at: OperatorTimestamp | null;
  /**
   * @type {EffectInstruction}
   */
  payload: OperatorJsonColumn<OperatorEffectInstruction>;
  run_id: string;
  seq: number;
  status: OperatorGenerated<OperatorAuthorityEffectStatus>;
  tries: OperatorGenerated<number>;
  unit_id: string;
  updated_at: OperatorGenerated<OperatorTimestamp>;
}

export interface OperatorAuthorityEvent {
  commit_txid: OperatorGenerated<number>;
  created_at: OperatorGenerated<OperatorTimestamp>;
  id: string;
  ingress_id: string | null;
  /**
   * @type {CoreEvent}
   */
  payload: OperatorJsonColumn<OperatorCoreEvent>;
  run_id: string;
  unit_id: string | null;
  /**
   * @type {Writer}
   */
  writer: OperatorJsonColumn<OperatorWriter>;
}

export interface OperatorAuthorityIngressReceipt {
  id: string;
  ingress_id: string;
  request_digest: string;
  /**
   * @type {CommitReceipt}
   */
  result: OperatorJsonColumn<OperatorCommitReceipt>;
  run_id: string;
  unit_id: string | null;
}

export interface OperatorAuthorityOperatorEvent {
  commit_txid: OperatorGenerated<number>;
  created_at: OperatorGenerated<OperatorTimestamp>;
  event_key: string;
  id: string;
  /**
   * @type {OperatorEventPayload}
   */
  payload: OperatorJsonColumn<OperatorEventPayload>;
  run_id: string | null;
  run_key: string;
}

export interface OperatorAuthorityProject {
  created_at: OperatorGenerated<OperatorTimestamp>;
  /**
   * @type {ForgeRepository}
   */
  forge_repository: OperatorNullableJsonColumn<OperatorForgeRepository>;
  id: string;
  integration_branch: string | null;
  name: string;
  repo_dir: string;
  /**
   * @type {SessionPolicy}
   */
  session_policy: OperatorNullableJsonColumn<OperatorSessionPolicy>;
}

export interface OperatorAuthorityPromptContent {
  content: string;
  content_digest: string;
}

export interface OperatorAuthorityReviewDecision {
  created_at: OperatorGenerated<OperatorTimestamp>;
  decision: string;
  effect: string;
  id: string;
  /**
   * @type {RuntimeValue}
   */
  payload: OperatorJsonColumn<OperatorRuntimeValue>;
  review: string;
  run_id: string;
  target_revision_id: string;
  unit_id: string;
}

export interface OperatorAuthorityReviewItem {
  artifact_revision_id: string | null;
  /**
   * @type {ReviewItemBody}
   */
  body: OperatorJsonColumn<OperatorReviewItemBody>;
  created_at: OperatorGenerated<OperatorTimestamp>;
  id: string;
  run_id: string;
  thread_id: string | null;
  unit_id: string;
}

export interface OperatorAuthorityRun {
  archived_at: OperatorTimestamp | null;
  created_at: OperatorGenerated<OperatorTimestamp>;
  definition_bundle_id: string;
  id: string;
  /**
   * @type {RuntimeValue}
   */
  input: OperatorNullableJsonColumn<OperatorRuntimeValue>;
  project_id: string | null;
  root_unit_id: string | null;
  /**
   * @type {UnitStatus}
   */
  status: OperatorGenerated<OperatorJsonColumn<OperatorUnitStatus>>;
  version: OperatorGenerated<number>;
}

export interface OperatorAuthorityUnit {
  collection_key: string | null;
  declaration: string;
  id: string;
  /**
   * @type {RuntimeValue}
   */
  input: OperatorJsonColumn<OperatorRuntimeValue>;
  parent_id: string | null;
  pool: string | null;
  /**
   * @type {ReviewPrompts}
   */
  review_prompts: OperatorGenerated<OperatorJsonColumn<OperatorReviewPrompts>>;
  run_id: string;
  stage: string | null;
  /**
   * @type {UnitStatus}
   */
  status: OperatorJsonColumn<OperatorUnitStatus>;
  unit_key: string;
  version: OperatorGenerated<number>;
}

export interface OperatorAuthorityUnitDependency {
  depends_on_id: string;
  run_id: string;
  unit_id: string;
}

export interface OperatorAuthorityWantedLog {
  /**
   * @type {WantedActions}
   */
  actions: OperatorJsonColumn<OperatorWantedActions>;
  event_id: string;
  id: string;
  run_id: string;
  unit_id: string;
}

export type OperatorJsonColumn<Value> = ColumnType<Value, OperatorJsonText<Value>, OperatorJsonText<Value>>;

export type OperatorRuntimeValue = unknown;

export type OperatorGenerated<T> = T extends ColumnType<infer S, infer I, infer U>
  ? ColumnType<S, I | undefined, U>
  : ColumnType<T, T | undefined, T>;

export type OperatorTimestamp = ColumnType<string, string | string, string | string>;

export type OperatorAttemptStatus = { readonly "kind": "pending" } | { readonly "kind": "running" } | { readonly "kind": "succeeded" } | { readonly "code": string; readonly "detail": string; readonly "kind": "failed" };

export type OperatorPinnedPrompts = { readonly [path: string]: string };

export type OperatorDefinitionBundleSource = OperatorWorkflow;

export interface OperatorEffectInstruction {
  readonly version: 1;
  readonly run_id: string;
  readonly action: OperatorRunWorkerAction;
  readonly attempt: { readonly action_id: string; readonly seq: number };
  readonly worker: OperatorWorkerInstruction;
  readonly inputs: unknown;
  readonly engine_inputs: OperatorEngineInputs;
  readonly workspace: unknown;
  readonly deadline_ms: number;
  readonly max_start_attempts: number;
}

export type OperatorAuthorityEffectStatus = "acknowledged" | "failed" | "pending" | "stop_requested" | "stopped";

export type OperatorCoreEvent = OperatorEvent;

export type OperatorCommitReceipt =
  | { readonly kind: "committed"; readonly event_id: string }
  | { readonly kind: "rejected"; readonly reason: string };

export type OperatorEventPayload =
  | { readonly kind: "run_event"; readonly data: OperatorRunEvent }
  | { readonly kind: "invalidate"; readonly data: { readonly target: "run" | "runs" | "definitions" | "projects"; readonly run_id: string | null } };

export type OperatorNullableJsonColumn<Value> = ColumnType<Value | null, OperatorJsonText<Value> | null, OperatorJsonText<Value> | null>;

export interface OperatorSessionPolicy { readonly version: number; readonly entries: readonly OperatorSessionPolicyEntry[] }

export type OperatorReviewPrompts = { readonly [review: string]: OperatorReviewPrompt };

export type OperatorWantedActions = readonly OperatorAction[];

export type OperatorJsonText<Value> = string & { readonly __json: Value };

export type OperatorWorkflow = { readonly "input": OperatorTypeExpression; readonly "run": OperatorGroup; readonly "schemas"?: { readonly [key: string]: OperatorTypeExpression }; readonly "stages": { readonly [key: string]: OperatorStage }; readonly "workflow": string };

export type OperatorRunWorkerAction = Extract<OperatorAction, { readonly kind: "run_worker" }>;

export type OperatorWorkerInstruction =
  | { readonly kind: "agent"; readonly session_key: string; readonly session: OperatorSessionMode; readonly prompt: OperatorPinnedPrompt;
      /** Pinned for `session: fresh` when the worker declares `prompts.handoff`; null otherwise. */
      readonly handoff: OperatorPinnedPrompt | null;
      readonly runtime: OperatorWorkerRuntime | null; readonly creates: readonly OperatorCreatedArtifact[];
      /** Every named schema the created artifacts' schemas still reference (inside `list(...)`, `optional(...)`), transitively. */
      readonly schemas: { readonly [name: string]: OperatorTypeExpression } }
  | { readonly kind: "code"; readonly operation: string; readonly every: string | null;
      /** The one artifact a code worker creates, which its output is published as. */
      readonly artifact: string };

export interface OperatorEngineInputs {
  readonly previous: OperatorRevisionState | null;
  readonly feedback: unknown;
  readonly subject: OperatorRevisionState | null;
}

export interface OperatorSessionPolicyEntry { readonly selector: OperatorSessionScopeSelector; readonly settings: OperatorSessionSettings }

export interface OperatorReviewPrompt { readonly target: string; readonly prompt: string }

export type OperatorAction = { readonly "cause": OperatorCause; readonly "kind": "run_worker"; readonly "mode": OperatorMode; readonly "unit": string; readonly "worker": string } | { readonly "input": unknown; readonly "kind": "start"; readonly "unit": string } | { readonly "kind": "complete"; readonly "outcome": unknown; readonly "unit": string };

export type OperatorTypeExpression = string | { readonly [key: string]: OperatorTypeExpression };

export type OperatorGroup = { readonly "outcome": { readonly [key: string]: string }; readonly "pools"?: { readonly [key: string]: number }; readonly "units": { readonly [key: string]: OperatorUnit } };

export type OperatorStage = { readonly "artifacts": { readonly [key: string]: OperatorArtifact }; readonly "done_when"?: string | null; readonly "input": OperatorTypeExpression; readonly "outcome": { readonly [key: string]: string }; readonly "reviews"?: { readonly [key: string]: OperatorReview }; readonly "workers": { readonly [key: string]: OperatorWorker } };

export type OperatorSessionMode = "resume" | "fresh";

export interface OperatorPinnedPrompt { readonly path: string; readonly digest: string }

export type OperatorWorkerRuntime = { readonly "harness": string; readonly "model": string };

export interface OperatorCreatedArtifact { readonly key: string; readonly schema: OperatorTypeExpression }

export type OperatorRevisionState = { readonly "artifact": string; readonly "body": unknown; readonly "by"?: string | null; readonly "id": string; readonly "predecessor"?: string | null; readonly "subject"?: string | null; readonly "unit": string };

export type OperatorSessionScopeSelector =
  | { readonly kind: "run" }
  | { readonly kind: "stage"; readonly stage_key: string }
  | { readonly kind: "stage_worker"; readonly stage_key: string; readonly worker_key: string };

export interface OperatorSessionSettings {
  readonly runtime: OperatorRuntimeId | null;
  readonly model: string | null;
  readonly effort: string | null;
}

export type OperatorUnit = { readonly "after"?: OperatorUnitDependencies; readonly "for_each"?: string | null; readonly "group"?: OperatorGroup | null; readonly "input"?: { readonly [key: string]: string }; readonly "key"?: string | null; readonly "pool"?: string | null; readonly "stage"?: string | null };

export type OperatorArtifact = { readonly "schema": OperatorTypeExpression; readonly "validate"?: (OperatorValidationCheck)[] };

export type OperatorReview = { readonly "by": OperatorReviewBy; readonly "decisions": { readonly [key: string]: OperatorReviewDecision }; readonly "inputs"?: { readonly [key: string]: string }; readonly "of": string; readonly "prompt"?: string | null; readonly "when"?: string | null };

export type OperatorWorker = { readonly "creates": (string)[]; readonly "inputs": { readonly [key: string]: string }; readonly "kind": "agent"; readonly "prompts": { readonly [key: string]: string }; readonly "reviews"?: string | null; readonly "runtime"?: OperatorWorkerRuntime | null; readonly "session"?: OperatorSessionMode | null; readonly "when"?: string | null; readonly "workspace"?: string | null } | { readonly "creates": (string)[]; readonly "every"?: string | null; readonly "inputs": { readonly [key: string]: string }; readonly "kind": "code"; readonly "operation": string; readonly "when"?: string | null };

export type OperatorRuntimeId = "claude-code" | "codex";

export type OperatorUnitDependencies = null | (string)[] | string;

export type OperatorValidationCheck = { readonly "check": string; readonly "message": string };

export type OperatorReviewBy = "operator" | "engine";

export type OperatorReviewDecision = { readonly "effect": OperatorDecisionEffect; readonly "feedback"?: string | null; readonly "fields"?: { readonly [key: string]: string }; readonly "label": string; readonly "on"?: string | null; readonly "payload"?: OperatorTypeExpression | null };
