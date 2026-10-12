// Generated from oakridge-dbos/src/http/operator-api.ts. Run bun kbbl/scripts/generate-operator-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

export interface OperatorStartPinnedRunRequest { readonly digest: string; readonly input: unknown; readonly request_id: string }

export interface OperatorStartedRun { readonly run_id: string; readonly bundle_id: string }

export interface OperatorRunPage { readonly items: readonly OperatorRunView[]; readonly next_cursor: string | null }

export interface OperatorRunView extends OperatorRunSummary {
  readonly cursor: readonly { readonly unit_id: string; readonly version: number }[]; readonly units: readonly OperatorRunUnitSummary[] }

export interface OperatorRunSummary { readonly run_id: string; readonly definition_bundle_id: string; readonly definition_digest: string; readonly version: number;
  readonly created_at: string; readonly archived_at: string | null }

export type OperatorRunDetail = OperatorRunView;

export interface OperatorDefinitionPage { readonly items: readonly OperatorDefinitionSummary[]; readonly next_cursor: string | null }

export interface OperatorDefinitionSummary { readonly bundle_id: string; readonly digest: string; readonly source: OperatorWorkflow; readonly archived_at: string | null }

export interface OperatorPinnedDefinition extends OperatorDefinitionSummary { readonly checked_program: OperatorCompiledWorkflow }

export interface OperatorUnitView {
  readonly run_id: string;
  readonly unit_id: string;
  /** The unit's declaration key, which names its stage in the workflow. */
  readonly unit_key: string;
  readonly stage: string | null;
  readonly status: OperatorUnitStatus;
  readonly version: number;
  readonly cursor: OperatorProjectionCursor;
  readonly revisions: readonly OperatorArtifactRevisionRecord[];
  /** artifact key -> its declared schema name, which selects the artifact's viewer. */
  readonly artifact_schemas: { readonly [artifact: string]: string };
  readonly open_reviews: readonly OperatorReviewItemRecord[];
  readonly decisions: readonly OperatorAvailableDecision[];
}

export interface OperatorAvailableDecision {
  readonly review: string;
  readonly decision: string;
  /** The artifact the review is `of`, so a caller can resolve the target revision. */
  readonly artifact: string;
  readonly label: string;
  readonly effect: OperatorReviewDecision["effect"];
  readonly fields: { readonly [field: string]: string };
  readonly payload: OperatorTypeExpression | null;
  readonly inputs: { readonly [input: string]: string };
}

export interface OperatorProjectionCursor { readonly unit_version: number; readonly event_id: string | null }

export type OperatorInboxItem =
  | { readonly kind: "decision"; readonly run_id: string; readonly unit_id: string; readonly unit_version: number;
      readonly review: string; readonly decision: string; readonly label: string }
  | { readonly kind: "wait"; readonly run_id: string; readonly unit_id: string; readonly unit_version: number;
      readonly reason: string; readonly label: string }
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
  readonly action_id: string;
  readonly seq: number;
}

export interface OperatorRunSessionAttempt {
  readonly location: OperatorSessionLocation;
  readonly worker: string;
  readonly mode: OperatorAttemptView["mode"];
  readonly status: OperatorAttemptView["status"];
  readonly kbbl_session_id: string | null;
}

export interface OperatorArtifactDetail {
  readonly run_id: string;
  readonly unit_id: string;
  readonly artifact: string;
  readonly revision_id: string;
  readonly predecessor_id: string | null;
  readonly subject: string | null;
  readonly body: unknown;
  readonly status: OperatorArtifactRevisionStatus;
  readonly presentation: OperatorArtifactPresentation;
}

export type OperatorArtifactRevisionStatus = "draft" | "approved" | "rejected";

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

export interface OperatorUnitHistory {
  readonly unit_id: string;
  readonly events: readonly OperatorUnitEventHistory[];
}

export interface OperatorUnitDiagnostics {
  readonly unit_id: string;
  readonly unit_version: number;
  readonly attempts: readonly OperatorAttemptView[];
  readonly effects: readonly OperatorEffectDiagnosticRecord[];
}

export interface OperatorUnitEventHistory {
  readonly id: string;
  readonly payload: OperatorEvent;
  readonly writer: OperatorWriter;
  readonly created_at: string;
}

export interface OperatorCommandReceipt { readonly kind: "accepted_pending"; readonly request_id: string; readonly event_id: string; readonly unit_version: number }

export interface OperatorUnitDecisionRequest {
  readonly unit_id: string;
  readonly review: string;
  readonly decision: string;
  readonly target_revision_id: string;
  readonly payload: unknown;
  readonly request_id: string;
  readonly expected_unit_version: number;
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
  readonly unit_id: string | null;
  /** The unit's declaration key; null for run-scoped events such as launch. */
  readonly unit_key: string | null;
  /** The v2 event that caused this frame, replacing v1's decision outcome kind. */
  readonly kind: OperatorEvent["kind"];
  readonly attention: OperatorRunAttention | null;
  /** The affected unit reached a terminal status in this event's transaction. */
  readonly is_terminal: boolean;
  /** ISO-8601, as authority.event recorded it. */
  readonly occurred_at: string;
}

export interface OperatorRunUnitSummary { readonly unit_id: string; readonly unit_key: string; readonly label: string; readonly version: number;
  readonly is_terminal: boolean; readonly available_decisions: readonly string[] }

export type OperatorWorkflow = { readonly "input": OperatorTypeExpression; readonly "run": OperatorGroup; readonly "schemas"?: { readonly [key: string]: OperatorTypeExpression }; readonly "stages": { readonly [key: string]: OperatorStage }; readonly "workflow": string };

export type OperatorCompiledWorkflow = { readonly "digest": string; readonly "stages": (string)[] };

export type OperatorUnitStatus = { readonly "kind": "not_started" } | { readonly "kind": "active" } | { readonly "kind": "blocked"; readonly "reason": OperatorBlockedReason } | { readonly "kind": "done"; readonly "outcome": unknown } | { readonly "kind": "cancelled" };

export type OperatorArtifactRevisionRecord = OperatorBranded<OperatorArtifactRevision, { id: string; run_id: string; unit_id: string; predecessor_id: string }>;

export type OperatorReviewItemRecord = OperatorBranded<OperatorReviewItem, { id: string; run_id: string; unit_id: string; artifact_revision_id: string; thread_id: string }>;

export type OperatorReviewDecision = { readonly "effect": OperatorDecisionEffect; readonly "fields"?: { readonly [key: string]: string }; readonly "label": string; readonly "on"?: string | null; readonly "payload"?: OperatorTypeExpression | null };

export type OperatorTypeExpression = string | { readonly [key: string]: OperatorTypeExpression };

export type OperatorAttemptView = Pick<OperatorAttemptRecord, "action_id" | "seq" | "unit_id" | "worker" | "mode" | "cause" | "status" | "ended_at" | "kbbl_session_id">;

export interface OperatorArtifactPresentation {
  readonly artifact_type: string;
  readonly viewer: "document" | "report";
  readonly capabilities: OperatorArtifactCapabilities;
}

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

export type OperatorEffectDiagnosticRecord = Pick<OperatorEffectIntentRecord, "id" | "action_id" | "seq" | "status">;

export type OperatorEvent = { readonly "input": unknown; readonly "kind": "launched" } | { readonly "action": string; readonly "kbbl_session_id"?: string | null; readonly "kind": "worker_started" } | { readonly "action": string; readonly "kind": "worker_ended"; readonly "result": OperatorWorkerResult } | { readonly "artifact": string; readonly "body": unknown; readonly "by": string; readonly "kind": "revision_published"; readonly "predecessor"?: string | null; readonly "subject"?: string | null; readonly "unit": string } | { readonly "decision": string; readonly "kind": "operator_decided"; readonly "payload": unknown; readonly "review": string; readonly "target": string; readonly "unit": string } | { readonly "kind": "retry_requested"; readonly "unit": string; readonly "worker": string } | { readonly "kind": "cancel_requested" };

export type OperatorWriter = { readonly "attempt": string; readonly "kind": "session"; readonly "session": string } | { readonly "attempt": string; readonly "kind": "executor" } | { readonly "kind": "operator"; readonly "subject": string } | { readonly "kind": "engine" };

export interface OperatorForgeRepository { readonly provider: "github"; readonly owner: string; readonly name: string }

export type OperatorProjectRecord = OperatorBranded<OperatorProject, { id: string }>;

export interface OperatorRunAttention { readonly review: string; readonly label: string }

export type OperatorGroup = { readonly "outcome": { readonly [key: string]: string }; readonly "pools"?: { readonly [key: string]: number }; readonly "units": { readonly [key: string]: OperatorUnit } };

export type OperatorStage = { readonly "artifacts": { readonly [key: string]: OperatorArtifact }; readonly "done_when"?: string | null; readonly "input": OperatorTypeExpression; readonly "outcome": { readonly [key: string]: string }; readonly "reviews"?: { readonly [key: string]: OperatorReview }; readonly "workers": { readonly [key: string]: OperatorWorker } };

export type OperatorBlockedReason = { readonly "kind": "waiting_on"; readonly "units": (string)[] } | { readonly "kind": "capacity"; readonly "pool": string };

export type OperatorBranded<Row, Ids extends { readonly [Column in keyof Ids]: Column extends keyof Row ? string : never }> =
  Readonly<Omit<Row, keyof Ids> & { readonly [Column in keyof Ids]: Column extends keyof Row ? null extends Row[Column] ? Ids[Column] | null : Ids[Column] : never }>;

export interface OperatorArtifactRevision {
  id: string;
  run_id: string;
  unit_id: string;
  artifact: string;
  /** @type {RuntimeValue} */
  body: OperatorRuntimeValue;
  by_id: string;
  predecessor_id: string | null;
  subject: string | null;
  created_at: string;
}

export interface OperatorReviewItem {
  id: string;
  run_id: string;
  unit_id: string;
  artifact_revision_id: string | null;
  thread_id: string | null;
  /** @type {ReviewItemBody} */
  body: OperatorReviewItemBody;
  created_at: string;
}

export type OperatorDecisionEffect = "approve" | "request_changes";

export type OperatorAttemptRecord = OperatorBranded<OperatorAttempt, { action_id: string; run_id: string; unit_id: string }>;

export interface OperatorArtifactCapabilities {
  readonly reviewable: boolean;
  readonly commentable: boolean;
  readonly atom_editable: boolean;
  readonly review_items: boolean;
}

export interface OperatorCollaborationThreadContext { readonly title: string; readonly anchor: string | null }

export interface OperatorCollaborationMessageBody { readonly text: string; readonly author: string; readonly ping?: boolean }

export interface OperatorReviewItemBody { readonly title: string; readonly detail: string; readonly status: string }

export type OperatorCollaborationDeliveryPayload =
  | { readonly status: "delivered"; readonly session_id: string; readonly reason: null; readonly request_key: string }
  | { readonly status: "failed"; readonly session_id: null; readonly reason: string; readonly request_key: string };

export type OperatorEffectIntentRecord = OperatorBranded<OperatorEffectIntent, { run_id: string; unit_id: string; action_id: string }>;

export type OperatorWorkerResult = { readonly "kind": "succeeded" } | { readonly "code": string; readonly "detail": string; readonly "kind": "failed" };

export interface OperatorProject {
  id: string;
  name: string;
  repo_dir: string;
  /** @type {ForgeRepository} */
  forge_repository: OperatorForgeRepository | null;
  integration_branch: string | null;
  /** @type {SessionPolicy} */
  session_policy: OperatorSessionPolicy | null;
  created_at: string;
}

export type OperatorUnit = { readonly "after"?: OperatorUnitDependencies; readonly "for_each"?: string | null; readonly "group"?: OperatorGroup | null; readonly "input"?: { readonly [key: string]: string }; readonly "key"?: string | null; readonly "pool"?: string | null; readonly "stage"?: string | null };

export type OperatorArtifact = { readonly "schema": OperatorTypeExpression; readonly "validate"?: (OperatorValidationCheck)[] };

export type OperatorReview = { readonly "by": OperatorReviewBy; readonly "decisions": { readonly [key: string]: OperatorReviewDecision }; readonly "inputs": { readonly [key: string]: string }; readonly "of": string; readonly "prompt"?: string | null };

export type OperatorWorker = { readonly "creates": (string)[]; readonly "inputs": { readonly [key: string]: string }; readonly "kind": "agent"; readonly "prompts": { readonly [key: string]: string }; readonly "reviews"?: string | null; readonly "runtime"?: OperatorWorkerRuntime | null; readonly "session"?: OperatorSessionMode | null; readonly "workspace"?: string | null } | { readonly "creates": (string)[]; readonly "every"?: string | null; readonly "inputs": { readonly [key: string]: string }; readonly "kind": "code"; readonly "operation": string };

export type OperatorRuntimeValue = unknown;

export interface OperatorAttempt {
  action_id: string;
  seq: number;
  run_id: string;
  unit_id: string;
  worker: string;
  /** @type {Mode} */
  mode: OperatorMode;
  /** @type {Cause} */
  cause: OperatorCause;
  /** @type {AttemptStatus} */
  status: OperatorAttemptStatus;
  ended_at: number | null;
  kbbl_session_id: string | null;
  publication_secret_hash: string | null;
}

export interface OperatorEffectIntent {
  id: string;
  run_id: string;
  unit_id: string;
  action_id: string;
  seq: number;
  /** @type {EffectIntentPayload} */
  payload: OperatorEffectIntentPayload;
  status: OperatorEffectStatus;
  updated_at: string;
}

export interface OperatorSessionPolicy { readonly version: number; readonly entries: readonly OperatorSessionPolicyEntry[] }

export type OperatorUnitDependencies = null | (string)[] | string;

export type OperatorValidationCheck = { readonly "check": string; readonly "message": string };

export type OperatorReviewBy = "operator";

export type OperatorWorkerRuntime = { readonly "harness": string; readonly "model": string };

export type OperatorSessionMode = "resume" | "fresh";

export type OperatorMode = { readonly "kind": "initial" } | { readonly "kind": "revise" } | { readonly "kind": "review" };

export type OperatorCause = { readonly "kind": "missing" } | { readonly "decision": string; readonly "kind": "changes_requested" } | { readonly "kind": "review_of"; readonly "revision": string } | { readonly "event": string; readonly "kind": "retry" } | { readonly "kind": "periodic" };

export type OperatorAttemptStatus = { readonly "kind": "pending" } | { readonly "kind": "running" } | { readonly "kind": "succeeded" } | { readonly "code": string; readonly "detail": string; readonly "kind": "failed" };

export type OperatorEffectIntentPayload = OperatorAction;

export type OperatorEffectStatus = 'acknowledged' | 'failed' | 'pending' | 'stop_requested' | 'stopped';

export interface OperatorSessionPolicyEntry { readonly selector: OperatorSessionScopeSelector; readonly settings: OperatorSessionSettings }

export type OperatorAction = { readonly "cause": OperatorCause; readonly "kind": "run_worker"; readonly "mode": OperatorMode; readonly "unit": string; readonly "worker": string } | { readonly "input": unknown; readonly "kind": "start"; readonly "unit": string } | { readonly "kind": "complete"; readonly "outcome": unknown; readonly "unit": string };

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
