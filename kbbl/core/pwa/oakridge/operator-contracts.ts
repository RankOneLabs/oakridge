// Generated from oakridge-dbos/src/http/operator-api.ts. Run bun kbbl/scripts/generate-operator-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

export interface OperatorRunPage { readonly items: readonly OperatorRunView[]; readonly next_cursor: string | null }

export interface OperatorRunView extends OperatorRunSummary { readonly units: readonly OperatorRunUnitSummary[] }

export interface OperatorRunSummary {
  readonly run_id: string; readonly definition_bundle_id: string; readonly definition_digest: string; readonly version: number;
  readonly status: OperatorUnitStatus; readonly created_at: string; readonly archived_at: string | null;
}

export type OperatorRunDetail = OperatorRunView;

export interface OperatorRunUnitSummary { readonly unit_id: string; readonly unit_key: string; readonly stage: string | null; readonly status: OperatorUnitStatus; readonly version: number }

export interface OperatorRunInspectView {
  readonly run_id: string;
  readonly status: OperatorUnitStatus;
  readonly units: readonly { readonly id: string; readonly stage: string | null; readonly status: OperatorUnitStatus }[];
  readonly attention: readonly OperatorInspectAttention[];
}

export interface OperatorInspectAttention {
  readonly kind: "stalled_worker";
  readonly unit_id: string;
  readonly worker: string;
  readonly action_id: string;
  readonly detail: string;
}

export interface OperatorDefinitionPage { readonly items: readonly OperatorDefinitionSummary[]; readonly next_cursor: string | null }

export interface OperatorDefinitionSummary { readonly bundle_id: string; readonly digest: string; readonly source: OperatorWorkflow; readonly archived_at: string | null }

export interface OperatorDefinitionDetail extends OperatorDefinitionSummary { readonly graph: OperatorDefinitionGraph }

export interface OperatorPinnedDefinition extends OperatorDefinitionSummary { readonly checked_program: OperatorCompiledWorkflow }

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
  /** The unit the event addressed; null for a launch or a cancel. */
  readonly unit_id: string | null;
  readonly kind: OperatorEvent["kind"];
  readonly run_status: OperatorUnitStatus["kind"];
  /** ISO-8601, as the event log recorded it. */
  readonly occurred_at: string;
}

export interface OperatorIngressRequest { readonly request_id: string }

export interface OperatorLaunchRequest extends OperatorIngressRequest { readonly digest: string; readonly input: unknown; readonly project_id?: string | null }

export interface OperatorDecideRequest extends OperatorIngressRequest { readonly decision: string; readonly target: string; readonly payload: unknown }

export type OperatorIngressResponse =
  | { readonly run_id: string; readonly event_id: string }
  | { readonly kind: "rejected"; readonly reason: string }
  | { readonly kind: "conflict"; readonly detail: string };

export type OperatorUnitStatus = { readonly "kind": "not_started" } | { readonly "kind": "active" } | { readonly "kind": "blocked"; readonly "reason": OperatorBlockedReason } | { readonly "kind": "done"; readonly "outcome": unknown } | { readonly "kind": "cancelled" };

export type OperatorWorkflow = { readonly "input": OperatorTypeExpression; readonly "run": OperatorGroup; readonly "schemas"?: { readonly [key: string]: OperatorTypeExpression }; readonly "stages": { readonly [key: string]: OperatorStage }; readonly "workflow": string };

export interface OperatorDefinitionGraph { readonly nodes: readonly OperatorDefinitionGraphNode[]; readonly edges: readonly { readonly from: string; readonly to: string }[] }

export type OperatorCompiledWorkflow = { readonly "digest": string; readonly "stages": (string)[] };

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

export type OperatorEvent = { readonly "input": unknown; readonly "kind": "launched" } | { readonly "action": string; readonly "kbbl_session_id"?: string | null; readonly "kind": "worker_started" } | { readonly "action": string; readonly "kind": "worker_ended"; readonly "result": OperatorWorkerResult } | { readonly "artifact": string; readonly "body": unknown; readonly "by": string; readonly "kind": "revision_published"; readonly "predecessor"?: string | null; readonly "subject"?: string | null; readonly "unit": string } | { readonly "decision": string; readonly "kind": "operator_decided"; readonly "payload": unknown; readonly "review": string; readonly "target": string; readonly "unit": string } | { readonly "kind": "retry_requested"; readonly "unit": string; readonly "worker": string } | { readonly "kind": "cancel_requested" };

export type OperatorBlockedReason = { readonly "kind": "waiting_on"; readonly "units": (string)[] } | { readonly "kind": "capacity"; readonly "pool": string };

export type OperatorTypeExpression = string | { readonly [key: string]: OperatorTypeExpression };

export type OperatorGroup = { readonly "outcome": { readonly [key: string]: string }; readonly "pools"?: { readonly [key: string]: number }; readonly "units": { readonly [key: string]: OperatorUnit } };

export type OperatorStage = { readonly "artifacts": { readonly [key: string]: OperatorArtifact }; readonly "done_when"?: string | null; readonly "input": OperatorTypeExpression; readonly "outcome": { readonly [key: string]: string }; readonly "reviews"?: { readonly [key: string]: OperatorReview }; readonly "workers": { readonly [key: string]: OperatorWorker } };

export interface OperatorDefinitionGraphNode { readonly key: string; readonly scope: string; readonly depends_on: readonly string[] }

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

export type OperatorUnit = { readonly "after"?: OperatorUnitDependencies; readonly "for_each"?: string | null; readonly "group"?: OperatorGroup | null; readonly "input"?: { readonly [key: string]: string }; readonly "key"?: string | null; readonly "pool"?: string | null; readonly "stage"?: string | null };

export type OperatorArtifact = { readonly "schema": OperatorTypeExpression; readonly "validate"?: (OperatorValidationCheck)[] };

export type OperatorReview = { readonly "by": OperatorReviewBy; readonly "decisions": { readonly [key: string]: OperatorReviewDecision }; readonly "inputs": { readonly [key: string]: string }; readonly "of": string; readonly "prompt"?: string | null };

export type OperatorWorker = { readonly "creates": (string)[]; readonly "inputs": { readonly [key: string]: string }; readonly "kind": "agent"; readonly "prompts": { readonly [key: string]: string }; readonly "reviews"?: string | null; readonly "runtime"?: OperatorWorkerRuntime | null; readonly "session"?: OperatorSessionMode | null; readonly "workspace"?: string | null } | { readonly "creates": (string)[]; readonly "every"?: string | null; readonly "inputs": { readonly [key: string]: string }; readonly "kind": "code"; readonly "operation": string };

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

export type OperatorUnitDependencies = null | (string)[] | string;

export type OperatorValidationCheck = { readonly "check": string; readonly "message": string };

export type OperatorReviewBy = "operator";

export type OperatorReviewDecision = { readonly "effect": OperatorDecisionEffect; readonly "fields"?: { readonly [key: string]: string }; readonly "label": string; readonly "on"?: string | null; readonly "payload"?: OperatorTypeExpression | null };

export type OperatorWorkerRuntime = { readonly "harness": string; readonly "model": string };

export type OperatorSessionMode = "resume" | "fresh";

export interface OperatorAuthorityArtifactRevision {
  artifact: string;
  /**
   * @type {RuntimeValue}
   */
  body: OperatorJsonColumn<OperatorRuntimeValue>;
  by_id: string;
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

export type OperatorDecisionEffect = "approve" | "request_changes";

export type OperatorJsonColumn<Value> = ColumnType<Value, OperatorJsonText<Value>, OperatorJsonText<Value>>;

export type OperatorRuntimeValue = unknown;

export type OperatorGenerated<T> = T extends ColumnType<infer S, infer I, infer U>
  ? ColumnType<S, I | undefined, U>
  : ColumnType<T, T | undefined, T>;

export type OperatorTimestamp = ColumnType<string, string | string, string | string>;

export type OperatorCause = { readonly "kind": "missing" } | { readonly "decision": string; readonly "kind": "changes_requested" } | { readonly "kind": "review_of"; readonly "revision": string } | { readonly "event": string; readonly "kind": "retry" } | { readonly "kind": "periodic" };

export type OperatorMode = { readonly "kind": "initial" } | { readonly "kind": "revise" } | { readonly "kind": "review" };

export type OperatorAttemptStatus = { readonly "kind": "pending" } | { readonly "kind": "running" } | { readonly "kind": "succeeded" } | { readonly "code": string; readonly "detail": string; readonly "kind": "failed" };

export type OperatorPinnedPrompts = { readonly [path: string]: string };

export type OperatorDefinitionBundleSource = OperatorWorkflow;

export interface OperatorEffectInstruction {
  readonly version: 1;
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

export type OperatorWriter = { readonly "attempt": string; readonly "kind": "session"; readonly "session": string } | { readonly "attempt": string; readonly "kind": "executor" } | { readonly "kind": "operator"; readonly "subject": string } | { readonly "kind": "engine" };

export type OperatorCommitReceipt =
  | { readonly kind: "committed"; readonly event_id: string }
  | { readonly kind: "rejected"; readonly reason: string };

export type OperatorEventPayload =
  | { readonly kind: "run_event"; readonly data: OperatorRunEvent }
  | { readonly kind: "invalidate"; readonly data: { readonly target: "run" | "runs" | "definitions" | "projects"; readonly run_id: string | null } };

export type OperatorNullableJsonColumn<Value> = ColumnType<Value | null, OperatorJsonText<Value> | null, OperatorJsonText<Value> | null>;

export interface OperatorSessionPolicy { readonly version: number; readonly entries: readonly OperatorSessionPolicyEntry[] }

export type OperatorWantedActions = readonly OperatorAction[];

export type OperatorJsonText<Value> = string & { readonly __json: Value };

export type OperatorRunWorkerAction = Extract<OperatorAction, { readonly kind: "run_worker" }>;

export type OperatorWorkerInstruction =
  | { readonly kind: "agent"; readonly session_key: string; readonly session: OperatorSessionMode; readonly prompt: OperatorPinnedPrompt; readonly runtime: OperatorWorkerRuntime | null }
  | { readonly kind: "code"; readonly operation: string; readonly every: string | null };

export interface OperatorEngineInputs {
  readonly previous: OperatorRevisionState | null;
  readonly feedback: unknown;
  readonly subject: OperatorRevisionState | null;
}

export interface OperatorSessionPolicyEntry { readonly selector: OperatorSessionScopeSelector; readonly settings: OperatorSessionSettings }

export type OperatorAction = { readonly "cause": OperatorCause; readonly "kind": "run_worker"; readonly "mode": OperatorMode; readonly "unit": string; readonly "worker": string } | { readonly "input": unknown; readonly "kind": "start"; readonly "unit": string } | { readonly "kind": "complete"; readonly "outcome": unknown; readonly "unit": string };

export interface OperatorPinnedPrompt { readonly path: string; readonly digest: string }

export type OperatorRevisionState = { readonly "artifact": string; readonly "body": unknown; readonly "by": string; readonly "id": string; readonly "predecessor"?: string | null; readonly "subject"?: string | null; readonly "unit": string };

export type OperatorSessionScopeSelector =
  | { readonly kind: "run" }
  | { readonly kind: "stage"; readonly stage_key: string }
  | { readonly kind: "stage_worker"; readonly stage_key: string; readonly worker_key: string };

export interface OperatorSessionSettings {
  readonly runtime: OperatorRuntimeId | null;
  readonly model: string | null;
  readonly effort: string | null;
}

export type OperatorRuntimeId = "claude-code" | "codex";
