// Generated from oakridge-dbos/src/http/operator-api.ts. Run bun kbbl/scripts/generate-operator-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

export interface OperatorRunPage { readonly items: readonly OperatorRunView[]; readonly next_cursor: string | null }

export interface OperatorRunView extends OperatorRunSummary { readonly units: readonly OperatorRunUnitSummary[] }

export interface OperatorRunSummary {
  readonly run_id: string; readonly definition_bundle_id: string; readonly definition_digest: string;
  readonly created_at: string; readonly updated_at: string; readonly archived_at: string | null;
  readonly title: string | null; readonly repository_keys: readonly string[];
  /** The root unit's status. */
  readonly status: OperatorUnitStatus;
}

export interface OperatorRunUnitSummary {
  readonly unit_id: string;
  readonly unit_key: string;
  readonly label: string;
  readonly stage: string | null;
  readonly status: OperatorUnitStatus;
  readonly is_terminal: boolean;
  /** Keys of the decisions that ask for the operator now (not the run's cancel). */
  readonly asks: readonly string[];
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
  /** The run could not advance past `event` (D-V4); the decisions are the run's cancel. */
  | { readonly kind: "stalled_run"; readonly unit_id: string; readonly stall: OperatorRunStall["kind"]; readonly reason: string; readonly event: OperatorEvent;
    readonly decisions: readonly OperatorDecisionDefinition[] }
  | { readonly kind: "stalled_worker"; readonly unit_id: string; readonly worker: string; readonly action_id: string; readonly detail: string;
    readonly decisions: readonly OperatorDecisionDefinition[] }
  | { readonly kind: "awaiting_review"; readonly unit_id: string; readonly review: string; readonly target: string;
    readonly decisions: readonly OperatorDecisionDefinition[] };

export interface OperatorDefinitionPage { readonly items: readonly OperatorDefinitionSummary[]; readonly next_cursor: string | null }

export interface OperatorDefinitionSummary { readonly bundle_id: string; readonly digest: string; readonly bundle: OperatorDefinitionBundle; readonly archived_at: string | null }

export interface OperatorDefinitionDetail extends OperatorDefinitionSummary { readonly workflow: OperatorWorkflow | OperatorAuthoredWorkflow; readonly graph: OperatorDefinitionGraph }

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
  readonly status: OperatorUnitStatus;
  readonly outcome: OperatorBodyValue | null;
  readonly is_terminal: boolean;
  readonly attention: OperatorAttention | null;
  readonly decisions: readonly OperatorDecisionDefinition[];
  readonly attempts: readonly OperatorAttemptView[];
  readonly artifacts: readonly OperatorArtifactView[];
}

export type OperatorInboxItem =
  | { readonly kind: "decision"; readonly run_id: string; readonly unit_id: string; readonly key: string; readonly label: string;
    readonly submit: OperatorDecisionSubmit;
    /** The awaiting review's prompt, rendered with its resolved inputs; null for a retry. */
    readonly prompt: string | null }
  | { readonly kind: "waiting"; readonly run_id: string; readonly unit_id: string; readonly reason: string; readonly label: string }
  | { readonly kind: "stalled"; readonly run_id: string; readonly unit_id: string; readonly detail: string };

export interface OperatorInboxPage { readonly items: readonly OperatorInboxItem[]; readonly next_cursor: string | null }

export interface OperatorRunInboxBatch { readonly items: readonly OperatorRunInboxBatchEntry[] }

export interface OperatorRunInboxBatchEntry { readonly run_id: string; readonly items: readonly OperatorInboxItem[] }

export interface OperatorArtifactDetail {
  readonly run_id: string;
  readonly unit_id: string;
  readonly artifact_key: string;
  readonly schema: string;
  readonly is_reviewable: boolean;
  readonly is_editable: boolean;
  /** Of the latest revision: its latest decision's effect, or draft while it has none. */
  readonly status: OperatorArtifactRevisionStatus;
  readonly revisions: readonly OperatorArtifactRevisionView[];
  readonly decisions: readonly OperatorRevisionDecision[];
  /** The launch spec, retained for comparing a published revised spec. */
  readonly original_spec: string | null;
}

export type OperatorArtifactRevisionStatus = "draft" | "approved" | "changes_requested";

export interface OperatorUnitHistory { readonly unit_id: string; readonly events: readonly OperatorEventHistory[]; readonly next_cursor: string | null }

export interface OperatorUnitDiagnostics {
  readonly unit_id: string;
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
}

export interface OperatorProjectDraft {
  readonly name: string;
  readonly repo_dir: string;
  readonly forge_repository: OperatorForgeRepository | null;
  readonly integration_branch: string | null;
}

export interface OperatorProjectList { readonly items: readonly OperatorProjectView[] }

export interface OperatorProjectView {
  readonly id: string;
  readonly name: string;
  readonly repo_dir: string;
  readonly forge_repository: OperatorForgeRepository | null;
  readonly integration_branch: string | null;
  readonly created_at: string;
}

export interface OperatorRunEvent {
  readonly event_id: string;
  readonly run_id: string;
  readonly unit_id: string;
  readonly unit_key: string;
  readonly kind: OperatorEvent["kind"];
  readonly awaiting: OperatorAwaitingReviewNotice | null;
  /** The addressed unit is done or cancelled. */
  readonly is_terminal: boolean;
  readonly run_status: OperatorUnitStatus["kind"];
  /** ISO-8601, as the event log recorded it. */
  readonly occurred_at: string;
}

export type OperatorStreamFrameData = OperatorStreamFrame["data"] & { readonly replay: boolean };

export interface OperatorStreamInvalidation { readonly kind: "invalidate"; readonly target: "run" | "runs" | "definitions" | "projects"; readonly run_id: string | null }

export interface OperatorSessionHold {
  readonly session_id: string;
  readonly run_id: string;
  readonly unit_id: string;
  readonly worker: string;
  /** The attempt's action id: the identity its own close carries. */
  readonly action_id: string;
}

export interface OperatorSessionHoldResponse { readonly hold: OperatorSessionHold | null; readonly location: OperatorSessionRunLocation | null }

export interface OperatorSessionRunLocation { readonly run_id: string; readonly unit_id: string }

export interface OperatorIngressRequest { readonly request_id: string }

export interface OperatorLaunchRequest extends OperatorIngressRequest {
  readonly digest: string; readonly input: unknown; readonly project_id?: string | null;
  /** Session settings keyed by stage, then by agent worker. */
  readonly config?: OperatorRunConfig | null;
}

export interface OperatorDecideRequest extends OperatorIngressRequest { readonly decision: string; readonly target: string; readonly payload: unknown }

export interface OperatorPublishRequest extends OperatorIngressRequest { readonly body: unknown; readonly predecessor: string | null; readonly subject: string | null }

export type OperatorIngressResponse = OperatorIngressCommitted
  | { readonly kind: "rejected"; readonly reason: string }
  | { readonly kind: "conflict"; readonly detail: string };

export interface OperatorIngressCommitted { readonly kind: "committed"; readonly run_id: string; readonly event_id: string }

export type OperatorUnitStatus = { readonly "kind": "not_started" } | { readonly "kind": "active" } | { readonly "kind": "done"; readonly "outcome": unknown } | { readonly "kind": "cancelled" };

export interface OperatorArtifactView {
  readonly run_id: string;
  readonly unit_id: string;
  readonly artifact_key: string;
  /** The schema name the PWA's viewer registry dispatches on. */
  readonly schema: string;
  /** An operator review of this artifact is declared. */
  readonly is_reviewable: boolean;
  /** An agent creates it, so the operator may publish an edited revision. */
  readonly is_editable: boolean;
  readonly revision_count: number;
  readonly latest_revision: OperatorArtifactRevisionView | null;
}

export interface OperatorAttemptView {
  /** Opaque: `<action id>:<seq>`. Show the worker, mode and cause instead. */
  readonly id: string;
  readonly unit_id: string;
  readonly worker: string;
  /** The attempt's position among its worker's attempts on the unit, from 1, in the order commit opened them. */
  readonly number: number;
  readonly status: OperatorAttemptStatusKind;
  readonly failure: OperatorAttemptFailure | null;
  readonly mode: OperatorMode["kind"];
  readonly cause: OperatorCause;
  readonly kbbl_session_id: string | null;
  readonly created_at: string;
  /** The worker's latest attempt; earlier ones are superseded. */
  readonly is_current: boolean;
}

export interface OperatorInspectEvent { readonly id: string; readonly unit_id: string | null; readonly kind: string; readonly writer: OperatorWriter; readonly created_at: string }

export interface OperatorRunStall {
  readonly kind: "stalled" | "faulted";
  /** Where advancing stopped; for a fault, the unit its event addressed (the root for a launch or a cancel). */
  readonly unit_id: string;
  readonly reason: string;
  /** The event it refused or faulted on. */
  readonly event: OperatorEvent;
  readonly ingress_id: string | null;
  /** When it was refused or recorded (ISO-8601). */
  readonly at: string;
}

export type OperatorEvent = { readonly "input": unknown; readonly "kind": "launched" } | { readonly "action": string; readonly "kbbl_session_id"?: string | null; readonly "kind": "worker_started" } | { readonly "action": string; readonly "kind": "worker_ended"; readonly "result": OperatorWorkerResult } | { readonly "artifact": string; readonly "body": unknown; readonly "by"?: string | null; readonly "kind": "revision_published"; readonly "predecessor"?: string | null; readonly "subject"?: string | null; readonly "unit": string } | { readonly "decision": string; readonly "kind": "operator_decided"; readonly "payload": unknown; readonly "review": string; readonly "target": string; readonly "unit": string } | { readonly "kind": "retry_requested"; readonly "unit": string; readonly "worker": string } | { readonly "kind": "cancel_requested" };

export interface OperatorDecisionDefinition {
  /** Unique within the unit: the decision key, `<review>:<decision>` where a stage reuses a key across reviews, `retry:<worker>`, or `cancel`. */
  readonly key: string;
  readonly label: string;
  readonly payload_schema: string;
  /** Labels for the payload's text fields. */
  readonly fields: readonly OperatorDecisionField[];
  readonly submit: OperatorDecisionSubmit;
}

export interface OperatorDefinitionBundle {
  readonly key: string;
  /** The root unit's key, as the run view lists it. */
  readonly root: string;
  readonly schemas: readonly OperatorSchema[];
  readonly units: readonly OperatorUnitDefinition[];
}

export type OperatorWorkflow = { readonly "input": OperatorTypeExpression; readonly "run": OperatorGroup; readonly "schemas"?: { readonly [key: string]: OperatorTypeExpression }; readonly "stages": { readonly [key: string]: OperatorStage }; readonly "workflow": string };

export type OperatorAuthoredWorkflow = { readonly "decisions"?: { readonly [key: string]: { readonly [key: string]: OperatorReviewDecision } }; readonly "input": OperatorTypeExpression; readonly "reviews"?: { readonly [key: string]: OperatorReview }; readonly "run": OperatorGroup; readonly "schemas"?: { readonly [key: string]: OperatorTypeExpression }; readonly "stages": { readonly [key: string]: OperatorAuthoredStage }; readonly "workers"?: { readonly [key: string]: OperatorWorker }; readonly "workflow": string };

export interface OperatorDefinitionGraph { readonly nodes: readonly OperatorDefinitionGraphNode[]; readonly edges: readonly { readonly from: string; readonly to: string }[] }

export type OperatorCompiledWorkflow = { readonly "digest": string; readonly "stages": (string)[]; readonly "workflow": OperatorParsedWorkflow };

export type OperatorBodyValue = OperatorJsonValue;

export type OperatorAttention = { readonly kind: "waiting"; readonly reason: string } | { readonly kind: "stalled"; readonly detail: string };

export type OperatorDecisionSubmit =
  | { readonly kind: "review"; readonly review: string; readonly decision: string; readonly effect: OperatorDeclaredDecisionEffect; readonly target_revision_id: string }
  | { readonly kind: "retry"; readonly worker: string }
  | { readonly kind: "cancel" };

export interface OperatorArtifactRevisionView {
  readonly id: string;
  readonly run_id: string;
  readonly unit_id: string;
  readonly artifact_key: string;
  /** The attempt that published it; null for an operator's edit. */
  readonly attempt_id: string | null;
  readonly body: OperatorBodyValue;
  readonly predecessor_id: string | null;
  /** The revision a review artifact reviews. */
  readonly subject_id: string | null;
  readonly created_at: string;
  /** The revision's position in its artifact, from 1. */
  readonly number: number;
}

export interface OperatorRevisionDecision {
  readonly id: string;
  readonly review: string;
  readonly decision: string;
  readonly effect: OperatorDeclaredDecisionEffect;
  readonly target_revision_id: string;
  readonly payload: OperatorBodyValue;
  readonly created_at: string;
}

export interface OperatorEventHistory {
  readonly id: string;
  /** The ingress id the event was committed under; null for an event with none. */
  readonly ingress_id: string | null;
  readonly event: OperatorEvent;
  readonly writer: OperatorWriter;
  readonly created_at: string;
}

export interface OperatorEffectDiagnostic {
  readonly id: string;
  readonly action_id: string;
  readonly seq: number;
  readonly status: OperatorAuthorityEffectStatus;
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

export interface OperatorForgeRepository { readonly provider: "github"; readonly owner: string; readonly name: string }

export interface OperatorAwaitingReviewNotice { readonly review: string; readonly label: string }

export type OperatorStreamFrame =
  | { readonly event: "run_event"; readonly data: OperatorRunEvent }
  | { readonly event: "invalidate"; readonly data: OperatorStreamInvalidation };

export interface OperatorRunConfig {
  readonly sessions: { readonly [stage: string]: { readonly [worker: string]: OperatorSessionSettings } };
}

export type OperatorAttemptStatusKind = OperatorAttemptStatus["kind"];

export interface OperatorAttemptFailure { readonly code: string; readonly detail: string }

export type OperatorMode = { readonly "kind": "initial" } | { readonly "kind": "revise" } | { readonly "kind": "review" };

export type OperatorCause = { readonly "kind": "missing" } | { readonly "decision": string; readonly "kind": "changes_requested" } | { readonly "kind": "review_of"; readonly "revision": string } | { readonly "event": string; readonly "kind": "retry"; readonly "mode": OperatorMode } | { readonly "inputs": string; readonly "kind": "periodic"; readonly "replaces"?: string | null };

export type OperatorWriter = { readonly "attempt": string; readonly "kind": "session"; readonly "session": string } | { readonly "attempt": string; readonly "kind": "executor" } | { readonly "kind": "operator"; readonly "subject": string } | { readonly "kind": "engine" };

export type OperatorWorkerResult = { readonly "kind": "succeeded" } | { readonly "code": string; readonly "detail": string; readonly "kind": "failed" };

export interface OperatorDecisionField { readonly key: string; readonly label: string }

export interface OperatorSchema { readonly key: string; readonly shape: OperatorSchemaShape }

export interface OperatorUnitDefinition {
  /** Its declaration path (`integration/repository`), as the definition graph keys it; `$root` for the root. Unique in the bundle. */
  readonly key: string;
  readonly stage: string | null;
  readonly label: string;
  readonly input_schema: string;
  readonly artifacts: readonly OperatorArtifactDefinition[];
}

export type OperatorTypeExpression = string | { readonly [key: string]: OperatorTypeExpression };

export type OperatorGroup = { readonly "outcome": { readonly [key: string]: string }; readonly "pools"?: { readonly [key: string]: number }; readonly "units": { readonly [key: string]: OperatorUnit } };

export type OperatorStage = { readonly "artifacts": { readonly [key: string]: OperatorArtifact }; readonly "done_when"?: string | null; readonly "input": OperatorTypeExpression; readonly "let"?: { readonly [key: string]: string }; readonly "outcome": { readonly [key: string]: string }; readonly "reviews"?: { readonly [key: string]: OperatorReview }; readonly "workers": { readonly [key: string]: OperatorWorker } };

export type OperatorReviewDecision = { readonly "effect": OperatorDeclaredDecisionEffect; readonly "feedback"?: string | null; readonly "fields"?: { readonly [key: string]: string }; readonly "label": string; readonly "on"?: string | null; readonly "payload"?: OperatorTypeExpression | null };

export type OperatorReview = { readonly "by": OperatorReviewBy; readonly "decisions": { readonly [key: string]: OperatorReviewDecision }; readonly "inputs"?: { readonly [key: string]: string }; readonly "of": string; readonly "prompt"?: string | null; readonly "when"?: string | null };

export type OperatorAuthoredStage = { readonly "artifacts": { readonly [key: string]: OperatorArtifact }; readonly "done_when"?: string | null; readonly "input": OperatorTypeExpression; readonly "let"?: { readonly [key: string]: string }; readonly "outcome": { readonly [key: string]: string }; readonly "reviews"?: { readonly [key: string]: OperatorAuthoredReview }; readonly "workers": { readonly [key: string]: OperatorAuthoredWorker } };

export type OperatorWorker = { readonly "creates": (string)[]; readonly "inputs": { readonly [key: string]: string }; readonly "kind": "agent"; readonly "prompts": OperatorPrompts; readonly "reviews"?: string | null; readonly "runtime"?: OperatorWorkerRuntime | null; readonly "session"?: OperatorSessionMode | null; readonly "when"?: string | null; readonly "workspace"?: string | null } | { readonly "creates": (string)[]; readonly "every"?: string | null; readonly "inputs": { readonly [key: string]: string }; readonly "kind": "code"; readonly "operation": string; readonly "when"?: string | null };

export interface OperatorDefinitionGraphNode { readonly key: string; readonly stage: string; readonly depends_on: readonly string[] }

export type OperatorParsedWorkflow = { readonly "input": OperatorType; readonly "run": OperatorGroup; readonly "schemas"?: { readonly [key: string]: OperatorType }; readonly "stages": { readonly [key: string]: OperatorParsedStage }; readonly "workflow": string };

export type OperatorJsonValue = OperatorJsonPrimitive | readonly OperatorJsonValue[] | { readonly [key: string]: OperatorJsonValue };

export type OperatorDeclaredDecisionEffect = "approve" | "request_changes";

export type OperatorAuthorityEffectStatus = "acknowledged" | "failed" | "pending" | "stop_requested" | "stopped";

export interface OperatorCollaborationThreadContext { readonly title: string; readonly anchor: string | null }

export interface OperatorCollaborationMessageBody { readonly text: string; readonly author: string }

export interface OperatorReviewItemBody { readonly title: string; readonly detail: string; readonly status: string }

export interface OperatorSessionSettings { readonly harness: string; readonly model: string; readonly effort: string | null }

export type OperatorAttemptStatus = { readonly "kind": "pending" } | { readonly "kind": "running" } | { readonly "kind": "succeeded" } | { readonly "code": string; readonly "detail": string; readonly "kind": "failed" };

export type OperatorSchemaShape =
  | { readonly kind: "boolean" }
  | { readonly kind: "integer"; readonly min: number; readonly max: number }
  | { readonly kind: "string"; readonly min_length: number; readonly max_length: number }
  | { readonly kind: "enum"; readonly variants: readonly string[] }
  | { readonly kind: "record"; readonly fields: readonly OperatorSchemaField[] }
  | { readonly kind: "list"; readonly item: string; readonly max_items: number }
  | { readonly kind: "optional"; readonly item: string };

export interface OperatorArtifactDefinition { readonly key: string; readonly schema: string }

export type OperatorUnit = { readonly "after"?: OperatorUnitDependencies; readonly "for_each"?: string | null; readonly "group"?: OperatorGroup | null; readonly "input"?: { readonly [key: string]: string }; readonly "key"?: string | null; readonly "pool"?: string | null; readonly "stage"?: string | null };

export type OperatorArtifact = { readonly "schema": OperatorTypeExpression; readonly "validate"?: (OperatorValidationCheck)[] };

export type OperatorReviewBy = "operator" | "engine";

export type OperatorAuthoredReview = OperatorAuthoredReviewDefinition | OperatorReviewUse;

export type OperatorAuthoredWorker = OperatorWorker | OperatorWorkerUse;

export type OperatorPrompts = { readonly "handoff"?: string | null; readonly "initial"?: string | null; readonly "review"?: string | null; readonly "revise"?: string | null };

export type OperatorWorkerRuntime = { readonly "harness": string; readonly "model": string };

export type OperatorSessionMode = "resume" | "fresh" | "shared";

export type OperatorType = { readonly "kind": "text" } | { readonly "kind": "ident" } | { readonly "kind": "repo_path" } | { readonly "kind": "boolean" } | { readonly "kind": "integer" } | { readonly "kind": "enum"; readonly "variants": (string)[] } | { readonly "kind": "optional"; readonly "value": OperatorType } | { readonly "item": OperatorType; readonly "kind": "list" } | { readonly "fields": { readonly [key: string]: OperatorType }; readonly "kind": "record" } | { readonly "kind": "named"; readonly "schema": string } | { readonly "kind": "outcome_of"; readonly "stage": string };

export type OperatorParsedStage = { readonly "artifacts": { readonly [key: string]: OperatorParsedArtifact }; readonly "done_when"?: string | null; readonly "input": OperatorType; readonly "let"?: { readonly [key: string]: string }; readonly "outcome": { readonly [key: string]: string }; readonly "reviews"?: { readonly [key: string]: OperatorParsedReview }; readonly "workers": { readonly [key: string]: OperatorWorker } };

export type OperatorJsonPrimitive = string | number | boolean | null;

export interface OperatorSchemaField { readonly key: string; readonly schema: string }

export type OperatorUnitDependencies = null | (string)[] | string;

export type OperatorValidationCheck = { readonly "check": string; readonly "message": string };

export type OperatorAuthoredReviewDefinition = { readonly "by": OperatorReviewBy; readonly "decisions": OperatorAuthoredDecisions; readonly "inputs"?: { readonly [key: string]: string }; readonly "of": string; readonly "prompt"?: string | null; readonly "when"?: string | null };

export type OperatorReviewUse = { readonly "overrides"?: OperatorReviewOverrides | null; readonly "template": string };

export type OperatorWorkerUse = { readonly "overrides"?: OperatorWorkerOverrides | null; readonly "template": string };

export type OperatorParsedArtifact = { readonly "schema": OperatorType; readonly "validate"?: (OperatorValidationCheck)[] };

export type OperatorParsedReview = { readonly "by": OperatorReviewBy; readonly "decisions": { readonly [key: string]: OperatorParsedReviewDecision }; readonly "inputs"?: { readonly [key: string]: string }; readonly "of": string; readonly "prompt"?: string | null; readonly "when"?: string | null };

export type OperatorAuthoredDecisions = { readonly [key: string]: OperatorReviewDecision } | OperatorDecisionSetUse;

export type OperatorReviewOverrides = { readonly "decisions"?: { readonly [key: string]: OperatorDecisionOverrides } | null; readonly "inputs"?: { readonly [key: string]: string } | null; readonly "of"?: string | null; readonly "prompt"?: string | null; readonly "when"?: string | null };

export type OperatorWorkerOverrides = { readonly "creates"?: (string)[] | null; readonly "every"?: string | null; readonly "inputs"?: { readonly [key: string]: string } | null; readonly "operation"?: string | null; readonly "prompts"?: OperatorPrompts | null; readonly "reviews"?: string | null; readonly "runtime"?: OperatorWorkerRuntime | null; readonly "session"?: OperatorSessionMode | null; readonly "when"?: string | null; readonly "workspace"?: string | null };

export type OperatorParsedReviewDecision = { readonly "effect": OperatorDeclaredDecisionEffect; readonly "feedback"?: string | null; readonly "fields"?: { readonly [key: string]: string }; readonly "label": string; readonly "on"?: string | null; readonly "payload"?: OperatorType | null };

export type OperatorDecisionSetUse = { readonly "overrides"?: { readonly [key: string]: OperatorDecisionOverrides }; readonly "rename"?: { readonly [key: string]: string }; readonly "set": string };

export type OperatorDecisionOverrides = { readonly "feedback"?: string | null; readonly "fields"?: { readonly [key: string]: string } | null; readonly "label"?: string | null; readonly "on"?: string | null; readonly "payload"?: OperatorTypeExpression | null };
