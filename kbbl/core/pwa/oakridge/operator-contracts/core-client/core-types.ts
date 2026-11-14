// Generated from oakridge-dbos/src/http/operator-api.ts. Run bun kbbl/scripts/generate-operator-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

export type OperatorUnitStatus = { readonly "kind": "not_started" } | { readonly "kind": "active" } | { readonly "kind": "done"; readonly "outcome": unknown } | { readonly "kind": "cancelled" };

export type OperatorEvent = { readonly "input": unknown; readonly "kind": "launched" } | { readonly "action": string; readonly "kbbl_session_id"?: string | null; readonly "kind": "worker_started" } | { readonly "action": string; readonly "kind": "worker_ended"; readonly "result": OperatorWorkerResult } | { readonly "artifact": string; readonly "body": unknown; readonly "by"?: string | null; readonly "kind": "revision_published"; readonly "predecessor"?: string | null; readonly "subject"?: string | null; readonly "unit": string } | { readonly "decision": string; readonly "kind": "operator_decided"; readonly "payload": unknown; readonly "review": string; readonly "target": string; readonly "unit": string } | { readonly "kind": "retry_requested"; readonly "unit": string; readonly "worker": string } | { readonly "kind": "cancel_requested" };

export type OperatorWorkflow = { readonly "input": OperatorTypeExpression; readonly "run": OperatorGroup; readonly "schemas"?: { readonly [key: string]: OperatorTypeExpression }; readonly "stages": { readonly [key: string]: OperatorStage }; readonly "workflow": string };

export type OperatorAuthoredWorkflow = { readonly "decisions"?: { readonly [key: string]: { readonly [key: string]: OperatorReviewDecision } }; readonly "input": OperatorTypeExpression; readonly "reviews"?: { readonly [key: string]: OperatorReview }; readonly "run": OperatorGroup; readonly "schemas"?: { readonly [key: string]: OperatorTypeExpression }; readonly "stages": { readonly [key: string]: OperatorAuthoredStage }; readonly "workers"?: { readonly [key: string]: OperatorWorker }; readonly "workflow": string };

export type OperatorParsedWorkflow = { readonly "input": OperatorType; readonly "run": OperatorGroup; readonly "schemas"?: { readonly [key: string]: OperatorType }; readonly "stages": { readonly [key: string]: OperatorParsedStage }; readonly "workflow": string };

export type OperatorMode = { readonly "kind": "initial" } | { readonly "kind": "revise" } | { readonly "kind": "review" };

export type OperatorCause = { readonly "kind": "missing" } | { readonly "decision": string; readonly "kind": "changes_requested" } | { readonly "kind": "review_of"; readonly "revision": string } | { readonly "event": string; readonly "kind": "retry"; readonly "mode": OperatorMode } | { readonly "inputs": string; readonly "kind": "periodic"; readonly "replaces"?: string | null };

export type OperatorWriter = { readonly "attempt": string; readonly "kind": "session"; readonly "session": string } | { readonly "attempt": string; readonly "kind": "executor" } | { readonly "kind": "operator"; readonly "subject": string } | { readonly "kind": "engine" };

export type OperatorWorkerResult = { readonly "kind": "succeeded" } | { readonly "code": string; readonly "detail": string; readonly "kind": "failed" };

export type OperatorTypeExpression = string | { readonly [key: string]: OperatorTypeExpression };

export type OperatorGroup = { readonly "outcome": { readonly [key: string]: string }; readonly "pools"?: { readonly [key: string]: number }; readonly "units": { readonly [key: string]: OperatorUnit } };

export type OperatorStage = { readonly "artifacts": { readonly [key: string]: OperatorArtifact }; readonly "done_when"?: string | null; readonly "input": OperatorTypeExpression; readonly "let"?: { readonly [key: string]: string }; readonly "outcome": { readonly [key: string]: string }; readonly "reviews"?: { readonly [key: string]: OperatorReview }; readonly "workers": { readonly [key: string]: OperatorWorker } };

export type OperatorReviewDecision = { readonly "effect": OperatorDeclaredDecisionEffect; readonly "feedback"?: string | null; readonly "fields"?: { readonly [key: string]: string }; readonly "label": string; readonly "on"?: string | null; readonly "payload"?: OperatorTypeExpression | null };

export type OperatorReview = { readonly "by": OperatorReviewBy; readonly "decisions": { readonly [key: string]: OperatorReviewDecision }; readonly "inputs"?: { readonly [key: string]: string }; readonly "of": string; readonly "prompt"?: string | null; readonly "when"?: string | null };

export type OperatorAuthoredStage = { readonly "artifacts": { readonly [key: string]: OperatorArtifact }; readonly "done_when"?: string | null; readonly "input": OperatorTypeExpression; readonly "let"?: { readonly [key: string]: string }; readonly "outcome": { readonly [key: string]: string }; readonly "reviews"?: { readonly [key: string]: OperatorAuthoredReview }; readonly "workers": { readonly [key: string]: OperatorAuthoredWorker } };

export type OperatorWorker = { readonly "evaluates"?: string | null; readonly "inputs": { readonly [key: string]: string }; readonly "kind": "agent"; readonly "produces": (string)[]; readonly "prompts": OperatorPrompts; readonly "runtime"?: OperatorWorkerRuntime | null; readonly "session"?: OperatorSessionMode | null; readonly "when"?: string | null; readonly "workspace"?: string | null } | { readonly "every"?: string | null; readonly "inputs": { readonly [key: string]: string }; readonly "kind": "code"; readonly "operation": string; readonly "produces": (string)[]; readonly "when"?: string | null };

export type OperatorType = { readonly "kind": "text" } | { readonly "generated": boolean; readonly "kind": "uuid" } | { readonly "kind": "ident" } | { readonly "kind": "repo_path" } | { readonly "kind": "boolean" } | { readonly "kind": "integer" } | { readonly "kind": "enum"; readonly "variants": (string)[] } | { readonly "kind": "optional"; readonly "value": OperatorType } | { readonly "item": OperatorType; readonly "kind": "list" } | { readonly "fields": { readonly [key: string]: OperatorType }; readonly "kind": "record" } | { readonly "kind": "named"; readonly "schema": string } | { readonly "kind": "outcome_of"; readonly "stage": string };

export type OperatorParsedStage = { readonly "artifacts": { readonly [key: string]: OperatorParsedArtifact }; readonly "done_when"?: string | null; readonly "input": OperatorType; readonly "let"?: { readonly [key: string]: string }; readonly "outcome": { readonly [key: string]: string }; readonly "reviews"?: { readonly [key: string]: OperatorParsedReview }; readonly "workers": { readonly [key: string]: OperatorWorker } };

export type OperatorInputProvenance = { readonly "input": string; readonly "revision_id": string; readonly "unit": string };

export type OperatorDeclaredDecisionEffect = "approve" | "request_changes";

export type OperatorAttemptStatus = { readonly "kind": "pending" } | { readonly "kind": "running" } | { readonly "kind": "succeeded" } | { readonly "code": string; readonly "detail": string; readonly "kind": "failed" };

export type OperatorUnit = { readonly "after"?: OperatorUnitDependencies; readonly "for_each"?: string | null; readonly "group"?: OperatorGroup | null; readonly "input"?: { readonly [key: string]: string }; readonly "key"?: string | null; readonly "pool"?: string | null; readonly "stage"?: string | null };

export type OperatorArtifact = { readonly "edit_policy"?: OperatorEditPolicy; readonly "kind": OperatorArtifactKind; readonly "schema": OperatorTypeExpression; readonly "validate"?: (OperatorValidationCheck)[] };

export type OperatorReviewBy = "operator" | "engine";

export type OperatorAuthoredReview = OperatorAuthoredReviewDefinition | OperatorReviewUse;

export type OperatorAuthoredWorker = OperatorWorker | OperatorWorkerUse;

export type OperatorPrompts = { readonly "handoff"?: string | null; readonly "initial"?: string | null; readonly "review"?: string | null; readonly "revise"?: string | null };

export type OperatorWorkerRuntime = { readonly "harness": string; readonly "model": string };

export type OperatorSessionMode = "resume" | "fresh" | "shared";

export type OperatorParsedArtifact = { readonly "edit_policy"?: OperatorEditPolicy; readonly "kind": OperatorArtifactKind; readonly "schema": OperatorType; readonly "validate"?: (OperatorValidationCheck)[] };

export type OperatorParsedReview = { readonly "by": OperatorReviewBy; readonly "decisions": { readonly [key: string]: OperatorParsedReviewDecision }; readonly "inputs"?: { readonly [key: string]: string }; readonly "of": string; readonly "prompt"?: string | null; readonly "when"?: string | null };

export type OperatorRevisionState = { readonly "artifact": string; readonly "body": unknown; readonly "by"?: string | null; readonly "decision_cursor"?: number; readonly "id": string; readonly "predecessor"?: string | null; readonly "seq": number; readonly "subject"?: string | null; readonly "unit": string };

export type OperatorFeedbackEntry = { readonly "decision": string; readonly "id": string; readonly "payload": unknown; readonly "review": string; readonly "target": string };

export type OperatorUnitDependencies = null | (string)[] | string;

export type OperatorEditPolicy = { readonly "kind": "always" } | { readonly "kind": "frozen_when_accepted" };

export type OperatorArtifactKind = "document" | "record" | "external_reference" | "assessment" | "status_record";

export type OperatorValidationCheck = { readonly "check": string; readonly "message": string };

export type OperatorAuthoredReviewDefinition = { readonly "by": OperatorReviewBy; readonly "decisions": OperatorAuthoredDecisions; readonly "inputs"?: { readonly [key: string]: string }; readonly "of": string; readonly "prompt"?: string | null; readonly "when"?: string | null };

export type OperatorReviewUse = { readonly "overrides"?: OperatorReviewOverrides | null; readonly "template": string };

export type OperatorWorkerUse = { readonly "overrides"?: OperatorWorkerOverrides | null; readonly "template": string };

export type OperatorParsedReviewDecision = { readonly "effect": OperatorDeclaredDecisionEffect; readonly "feedback"?: string | null; readonly "fields"?: { readonly [key: string]: string }; readonly "label": string; readonly "on"?: string | null; readonly "payload"?: OperatorType | null };

export type OperatorAuthoredDecisions = { readonly [key: string]: OperatorReviewDecision } | OperatorDecisionSetUse;

export type OperatorReviewOverrides = { readonly "decisions"?: { readonly [key: string]: OperatorDecisionOverrides } | null; readonly "inputs"?: { readonly [key: string]: string } | null; readonly "of"?: string | null; readonly "prompt"?: string | null; readonly "when"?: string | null };

export type OperatorWorkerOverrides = { readonly "evaluates"?: string | null; readonly "every"?: string | null; readonly "inputs"?: { readonly [key: string]: string } | null; readonly "operation"?: string | null; readonly "produces"?: (string)[] | null; readonly "prompts"?: OperatorPrompts | null; readonly "runtime"?: OperatorWorkerRuntime | null; readonly "session"?: OperatorSessionMode | null; readonly "when"?: string | null; readonly "workspace"?: string | null };

export type OperatorDecisionSetUse = { readonly "overrides"?: { readonly [key: string]: OperatorDecisionOverrides }; readonly "rename"?: { readonly [key: string]: string }; readonly "set": string };

export type OperatorDecisionOverrides = { readonly "feedback"?: string | null; readonly "fields"?: { readonly [key: string]: string } | null; readonly "label"?: string | null; readonly "on"?: string | null; readonly "payload"?: OperatorTypeExpression | null };
