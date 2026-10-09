// Generated from oakridge-dbos/src/http/operator-api.ts. Run bun kbbl/scripts/generate-operator-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

export interface OperatorStartPinnedRunRequest { readonly digest: string; readonly input: unknown; readonly request_id: string }

export interface OperatorStartedRun { readonly run_id: string; readonly root_scope_id: string; readonly bundle_id: string }

export interface OperatorRunPage { readonly items: readonly OperatorRunView[]; readonly next_cursor: string | null }

export interface OperatorRunView { readonly run_id: string; readonly definition_bundle_id: string; readonly definition_digest: string; readonly version: number; readonly cursor: readonly { readonly scope_id: string; readonly version: number }[]; readonly scopes: readonly OperatorRunScopeSummary[] }

export interface OperatorDefinitionPage { readonly items: readonly OperatorDefinitionSummary[]; readonly next_cursor: string | null }

export interface OperatorDefinitionSummary { readonly bundle_id: string; readonly digest: string; readonly source: OperatorDefinitionBundle }

export interface OperatorPinnedDefinition extends OperatorDefinitionSummary { readonly checked_program: OperatorCompiledBundle }

export interface OperatorScopeView {
  readonly scope_id: string; readonly run_id: string; readonly scope_key: string; readonly label: string;
  readonly state: OperatorCheckedValue; readonly outcome: OperatorCheckedValue | null; readonly is_terminal: boolean;
  readonly commands: readonly OperatorCommandDefinition[]; readonly executions: readonly OperatorExecutionView[];
  readonly outputs: readonly OperatorOutputSlotView[]; readonly resources: readonly OperatorResourceBindingRecord[];
  readonly command_targets: Readonly<{ readonly [command_key: string]: readonly OperatorTargetRevision[] }>;
  readonly command_prefill: Readonly<{ readonly [command_key: string]: OperatorCommandPrefill }>;
  readonly decision: OperatorDecisionOutcome | null; readonly cursor: OperatorProjectionCursor;
}

export type OperatorInboxItem =
  | { readonly kind: "command"; readonly run_id: string; readonly scope_id: string; readonly scope_version: number; readonly key: string; readonly label: string; readonly consequence: string }
  | { readonly kind: "wait"; readonly run_id: string; readonly scope_id: string; readonly scope_version: number; readonly reason: string; readonly label: string }
  | { readonly kind: "diagnostic"; readonly run_id: string; readonly scope_id: string; readonly scope_version: number; readonly detail: string };

export interface OperatorInboxPage {
  readonly cursor: readonly { readonly scope_id: string; readonly version: number }[];
  readonly items: readonly OperatorInboxItem[]; readonly next_cursor: string | null;
}

export interface OperatorScopeHistory {
  readonly scope_id: string;
  readonly transitions: readonly OperatorTransitionHistory<string>[];
  readonly facts: readonly OperatorScopeFactHistory[];
}

export interface OperatorCommandReceipt { readonly kind: "accepted_pending"; readonly request_id: string; readonly transition_id: string; readonly scope_version: number }

export interface OperatorScopeCommandRequest {
  readonly command_key: string;
  readonly payload: unknown;
  readonly request_id: string;
  readonly scope_id: string;
  readonly expected_scope_version: number;
  readonly targets: readonly OperatorTargetRevision[];
}

export interface OperatorRunScopeSummary { readonly scope_id: string; readonly scope_key: string; readonly label: string; readonly version: number; readonly is_terminal: boolean; readonly available_commands: readonly string[] }

export type OperatorDefinitionBundle = { readonly "key": string; readonly "language_version": number; readonly "limits": OperatorResourceLimits; readonly "operations": (OperatorOperationManifest)[]; readonly "prompts": (OperatorPrompt)[]; readonly "root": string; readonly "schemas": (OperatorSchema)[]; readonly "scopes": (OperatorScopeDefinition)[]; readonly "version": number };

export type OperatorCompiledBundle = { readonly "digest": string; readonly "scopes": (OperatorCheckedScope)[] };

export type OperatorCheckedValue = { readonly "data": OperatorCheckedData; readonly "schema": string };

export type OperatorCommandDefinition = { readonly "available_in": (string)[]; readonly "consequence": string; readonly "field_presentation": (OperatorCommandFieldPresentation)[]; readonly "key": string; readonly "label": string; readonly "payload_schema": string; readonly "prefill"?: (OperatorCommandFieldPrefill)[]; readonly "required": boolean; readonly "targets": (OperatorExpression)[] };

export type OperatorExecutionView = Pick<OperatorExecutionRecord, "id" | "scope_id" | "worker_key" | "generation" | "status" | "result" | "version">;

export interface OperatorOutputSlotView extends OperatorOutputSlotRecord { readonly current_revision: OperatorArtifactRevisionRecord | null }

export type OperatorResourceBindingRecord = OperatorBranded<OperatorResourceBinding, { run_id: string; scope_id: string }>;

export interface OperatorTargetRevision { readonly identity: string; readonly version: number }

export type OperatorCommandPrefill = Readonly<{ readonly [field_key: string]: OperatorJsonValue }>;

export type OperatorDecisionOutcome = { readonly "explanation": OperatorExplanation; readonly "invocations": (OperatorInvocation)[]; readonly "kind": "apply"; readonly "mutations": (OperatorMutationValue)[]; readonly "outcome"?: OperatorCheckedValue | null; readonly "targets": (OperatorCheckedValue)[] } | { readonly "attention"?: OperatorAttentionMetadata | null; readonly "continuations": (string)[]; readonly "explanation": OperatorExplanation; readonly "kind": "wait"; readonly "reason": string } | { readonly "detail": OperatorCheckedValue; readonly "error": string; readonly "explanation": OperatorExplanation; readonly "kind": "reject" };

export interface OperatorProjectionCursor { readonly scope_version: number; readonly transition_id: string | null }

export interface OperatorTransitionHistory<Timestamp> extends Omit<OperatorStoredTransitionHistory<Timestamp>, "version"> { readonly version: number }

export interface OperatorScopeFactHistory { readonly id: string; readonly fact_key: string; readonly payload: OperatorCheckedValue }

export type OperatorResourceLimits = { readonly "evaluation_budget": number; readonly "max_depth": number; readonly "max_list_items": number };

export type OperatorOperationManifest = { readonly "emitted_codes"?: (string)[]; readonly "input_contract": string; readonly "input_schema": string; readonly "key": string; readonly "provider_kind": string; readonly "recovery"?: (OperatorRecoveryMapping)[]; readonly "required_recovery_codes"?: (string)[]; readonly "settings": (string)[]; readonly "tools": (string)[]; readonly "version": number };

export type OperatorPrompt = { readonly "content_digest": string; readonly "input_schema": string; readonly "key": string; readonly "path": string };

export type OperatorSchema = { readonly "key": string; readonly "shape": OperatorSchemaShape };

export type OperatorScopeDefinition = { readonly "cancellation": OperatorCancellationDefinition; readonly "children": (OperatorChildDefinition)[]; readonly "commands": (OperatorCommandDefinition)[]; readonly "entry_command"?: string | null; readonly "entry_payload"?: OperatorLifecyclePayloadProjection; readonly "errors": (OperatorFactDefinition)[]; readonly "exports": (OperatorExportDefinition)[]; readonly "facts": (OperatorFactDefinition)[]; readonly "initial": unknown; readonly "input_schema": string; readonly "key": string; readonly "outcome_schema": string; readonly "outputs": (OperatorOutputDefinition)[]; readonly "pools": (OperatorCapacityPool)[]; readonly "presentation": OperatorPresentation; readonly "resources": (OperatorExportDefinition)[]; readonly "state_schema": string; readonly "tree": OperatorDecisionTree; readonly "workers": (OperatorWorkerDefinition)[] };

export type OperatorCheckedScope = { readonly "children": (OperatorCheckedChild)[]; readonly "command_targets": (OperatorCheckedCommandTargets)[]; readonly "initial": OperatorCheckedValue; readonly "key": string; readonly "reads": (OperatorReferenceRoot)[]; readonly "tree": OperatorCheckedTree };

export type OperatorCheckedData = { readonly "kind": "boolean"; readonly "value": boolean } | { readonly "kind": "integer"; readonly "value": number } | { readonly "kind": "string"; readonly "value": string } | { readonly "kind": "enum"; readonly "variant": string } | { readonly "dictionary": (OperatorDictionaryEntry)[]; readonly "fields": (OperatorCheckedField)[]; readonly "kind": "record" } | { readonly "items": (OperatorCheckedValue)[]; readonly "kind": "list" } | { readonly "kind": "optional"; readonly "value"?: OperatorCheckedValue | null } | { readonly "kind": "variant"; readonly "value": OperatorCheckedValue; readonly "variant": string } | { readonly "brand": OperatorReferenceBrand; readonly "id": string; readonly "kind": "reference" };

export type OperatorCommandFieldPresentation = { readonly "key": string; readonly "presentation": OperatorPresentation };

export type OperatorCommandFieldPrefill = { readonly "key": string; readonly "value": OperatorExpression };

export type OperatorExpression = { readonly "kind": "literal"; readonly "schema": string; readonly "value": unknown } | { readonly "kind": "reference"; readonly "path": (string)[]; readonly "root": OperatorReferenceRoot } | { readonly "fields": (OperatorFieldExpression)[]; readonly "kind": "record"; readonly "schema": string } | { readonly "items": (OperatorExpression)[]; readonly "kind": "list"; readonly "schema": string } | { readonly "kind": "variant"; readonly "schema": string; readonly "value": OperatorExpression; readonly "variant": string } | { readonly "kind": "equals"; readonly "left": OperatorExpression; readonly "right": OperatorExpression } | { readonly "kind": "is_variant"; readonly "value": OperatorExpression; readonly "variant": string } | { readonly "items": (OperatorExpression)[]; readonly "kind": "all" } | { readonly "items": (OperatorExpression)[]; readonly "kind": "any" } | { readonly "kind": "not"; readonly "value": OperatorExpression } | { readonly "kind": "map"; readonly "schema": string; readonly "source": OperatorExpression; readonly "value": OperatorExpression } | { readonly "kind": "optional"; readonly "schema": string; readonly "value"?: OperatorExpression | null } | { readonly "key": string; readonly "kind": "field"; readonly "value": OperatorExpression } | { readonly "key": OperatorExpression; readonly "key_field": string; readonly "kind": "filter_by"; readonly "source": OperatorExpression } | { readonly "kind": "contains"; readonly "source": OperatorExpression; readonly "value": OperatorExpression } | { readonly "key": OperatorExpression; readonly "key_field": string; readonly "kind": "lookup"; readonly "source": OperatorExpression } | { readonly "kind": "filter"; readonly "predicate": OperatorExpression; readonly "source": OperatorExpression } | { readonly "key_field": string; readonly "kind": "unique_by"; readonly "source": OperatorExpression } | { readonly "dependencies_field": string; readonly "key_field": string; readonly "kind": "check_collection"; readonly "source": OperatorExpression } | { readonly "kind": "every"; readonly "predicate": OperatorExpression; readonly "source": OperatorExpression };

export type OperatorExecutionRecord = OperatorBranded<OperatorExecution, { id: string; run_id: string; scope_id: string }>;

export type OperatorOutputSlotRecord = OperatorBranded<OperatorOutputSlot, { run_id: string; scope_id: string; current_revision_id: string }>;

export type OperatorArtifactRevisionRecord = OperatorBranded<OperatorArtifactRevision, { id: string; run_id: string; scope_id: string; execution_id: string; predecessor_id: string }>;

export type OperatorBranded<Row, Ids extends { readonly [Column in keyof Ids]: Column extends keyof Row ? string : never }> =
  Readonly<Omit<Row, keyof Ids> & { readonly [Column in keyof Ids]: Column extends keyof Row ? null extends Row[Column] ? Ids[Column] | null : Ids[Column] : never }>;

export interface OperatorResourceBinding {
  id: string;
  run_id: string;
  scope_id: string;
  resource_key: string;
  /** @type {CheckedValue} */
  observation: OperatorCheckedValue | null;
  version: number;
}

export type OperatorJsonValue = OperatorJsonPrimitive | readonly OperatorJsonValue[] | { readonly [key: string]: OperatorJsonValue };

export type OperatorExplanation = { readonly "bundle_digest": string; readonly "node_id": string; readonly "owner": string; readonly "read_set": (OperatorReadVersion)[]; readonly "trace": (string)[]; readonly "trigger_id": string };

export type OperatorInvocation = { readonly "definition": OperatorInvocationContract; readonly "input": OperatorCheckedValue; readonly "prompt_key"?: string | null; readonly "selection": OperatorActionSelection };

export type OperatorMutationValue = { readonly "kind": "set_state"; readonly "value": OperatorCheckedValue } | { readonly "key": string; readonly "kind": "export"; readonly "value": OperatorCheckedValue } | { readonly "input": OperatorCheckedValue; readonly "key": string; readonly "kind": "activate_child" } | { readonly "key": string; readonly "kind": "activate_collection"; readonly "materialization": OperatorMaterialization } | { readonly "key": string; readonly "kind": "cancel_children" } | { readonly "key": string; readonly "kind": "clear_output" } | { readonly "kind": "acquire"; readonly "pool": string } | { readonly "kind": "release"; readonly "pool": string } | { readonly "kind": "revoke"; readonly "worker": string } | { readonly "kind": "stop"; readonly "worker": string } | { readonly "key": string; readonly "kind": "bind_resource"; readonly "value": OperatorCheckedValue } | { readonly "key": string; readonly "kind": "clear_resource" } | { readonly "kind": "observe"; readonly "resource": string };

export type OperatorAttentionMetadata = { readonly "label": string; readonly "trigger": string };

export interface OperatorStoredTransitionHistory<Timestamp> {
  readonly id: string; readonly trigger_id: string; readonly decision: OperatorDecisionOutcome;
  readonly created_at: Timestamp; readonly version: OperatorSqlVersion;
}

export type OperatorRecoveryMapping = { readonly "code": string; readonly "fact": string };

export type OperatorSchemaShape = { readonly "kind": "boolean" } | { readonly "kind": "integer"; readonly "max": number; readonly "min": number } | { readonly "kind": "string"; readonly "max_length": number; readonly "min_length": number } | { readonly "kind": "enum"; readonly "variants": (string)[] } | { readonly "dictionary"?: string | null; readonly "fields": (OperatorSchemaField)[]; readonly "kind": "record" } | { readonly "item": string; readonly "kind": "list"; readonly "max_items": number } | { readonly "item": string; readonly "kind": "optional" } | { readonly "kind": "union"; readonly "variants": (OperatorSchemaVariant)[] } | { readonly "brand": OperatorReferenceBrand; readonly "kind": "reference" };

export type OperatorCancellationDefinition = { readonly "payload"?: OperatorLifecyclePayloadProjection; readonly "trigger": string };

export type OperatorChildDefinition = { readonly "collection"?: OperatorCollectionDefinition | null; readonly "depends_on": (string)[]; readonly "imports": (string)[]; readonly "input": OperatorExpression; readonly "key": string; readonly "on_terminal"?: string | null; readonly "on_terminal_payload"?: OperatorLifecyclePayloadProjection; readonly "prerequisite_export"?: string | null; readonly "scope": string };

export type OperatorLifecyclePayloadProjection = { readonly "kind": "empty_record" } | { readonly "kind": "reason" } | { readonly "kind": "literal"; readonly "value": unknown };

export type OperatorFactDefinition = { readonly "key": string; readonly "payload_schema": string };

export type OperatorExportDefinition = { readonly "key": string; readonly "schema": string };

export type OperatorOutputDefinition = { readonly "collection_key"?: string | null; readonly "key": string; readonly "policy": OperatorPublicationPolicy; readonly "producers": (string)[]; readonly "publication_trigger"?: string | null; readonly "schema": string };

export type OperatorCapacityPool = { readonly "key": string; readonly "limit": number };

export type OperatorPresentation = { readonly "label": string; readonly "viewer"?: string | null };

export type OperatorDecisionTree = { readonly "cases": (OperatorMatchCase)[]; readonly "id": string; readonly "kind": "match"; readonly "otherwise"?: OperatorDecisionTree | null; readonly "value": OperatorExpression } | { readonly "condition": OperatorExpression; readonly "id": string; readonly "kind": "if"; readonly "otherwise": OperatorDecisionTree; readonly "then": OperatorDecisionTree } | { readonly "actions": (OperatorActionSelection)[]; readonly "id": string; readonly "kind": "apply"; readonly "mutations": (OperatorMutation)[]; readonly "outcome"?: OperatorExpression | null } | { readonly "attention": OperatorAttentionMetadata; readonly "continuations": (string)[]; readonly "id": string; readonly "kind": "wait"; readonly "reason": string } | { readonly "detail": unknown; readonly "error": string; readonly "id": string; readonly "kind": "reject" };

export type OperatorWorkerDefinition = { readonly "actions": (OperatorActionDefinition)[]; readonly "exclusive": boolean; readonly "key": string; readonly "result_schema": string };

export type OperatorCheckedChild = { readonly "collection"?: OperatorCheckedCollection | null; readonly "input": OperatorCheckedExpression; readonly "key": string };

export type OperatorCheckedCommandTargets = { readonly "command": string; readonly "targets": (OperatorCheckedExpression)[] };

export type OperatorReferenceRoot = { readonly "kind": "input" } | { readonly "kind": "state" } | { readonly "kind": "trigger" } | { readonly "key": string; readonly "kind": "output" } | { readonly "kind": "result"; readonly "worker": string } | { readonly "key": string; readonly "kind": "resource" } | { readonly "export": string; readonly "key": string; readonly "kind": "child" } | { readonly "key": string; readonly "kind": "output_collection"; readonly "schema": string } | { readonly "key": string; readonly "kind": "output_revision"; readonly "schema": string } | { readonly "key": string; readonly "kind": "output_revisions"; readonly "schema": string } | { readonly "key": string; readonly "kind": "optional_output_revision"; readonly "schema": string } | { readonly "export": string; readonly "key": string; readonly "kind": "children"; readonly "schema": string } | { readonly "key": string; readonly "kind": "children_outcomes"; readonly "schema": string } | { readonly "key": string; readonly "kind": "children_complete"; readonly "schema": string } | { readonly "kind": "item" };

export type OperatorCheckedTree = { readonly "cases": (OperatorCheckedCase)[]; readonly "id": string; readonly "kind": "match"; readonly "otherwise"?: OperatorCheckedTree | null; readonly "value": OperatorCheckedExpression } | { readonly "condition": OperatorCheckedExpression; readonly "id": string; readonly "kind": "if"; readonly "otherwise": OperatorCheckedTree; readonly "then": OperatorCheckedTree } | { readonly "actions": (OperatorCheckedAction)[]; readonly "id": string; readonly "kind": "apply"; readonly "mutations": (OperatorCheckedMutation)[]; readonly "outcome"?: OperatorCheckedExpression | null } | { readonly "attention": OperatorAttentionMetadata; readonly "continuations": (string)[]; readonly "id": string; readonly "kind": "wait"; readonly "reason": string } | { readonly "detail": OperatorCheckedValue; readonly "error": string; readonly "id": string; readonly "kind": "reject" };

export type OperatorDictionaryEntry = { readonly "key": string; readonly "value": OperatorCheckedValue };

export type OperatorCheckedField = { readonly "field_id": number; readonly "value"?: OperatorCheckedValue | null };

export type OperatorReferenceBrand = "instance" | "execution" | "artifact_revision" | "resource";

export type OperatorFieldExpression = { readonly "key": string; readonly "value": OperatorExpression };

export interface OperatorExecution {
  id: string;
  run_id: string;
  scope_id: string;
  worker_key: string;
  generation: number;
  status: OperatorExecutionStatus;
  /** @type {CheckedValue} */
  result: OperatorCheckedValue | null;
  publication_secret_hash: string | null;
  version: number;
}

export interface OperatorOutputSlot {
  id: string;
  run_id: string;
  scope_id: string;
  output_key: string;
  collection_key: string;
  current_revision_id: string | null;
  version: number;
}

export interface OperatorArtifactRevision {
  id: string;
  run_id: string;
  scope_id: string;
  execution_id: string | null;
  output_key: string;
  collection_key: string;
  /** @type {CheckedValue} */
  body: OperatorCheckedValue;
  predecessor_id: string | null;
  version: number;
}

export type OperatorJsonPrimitive = string | number | boolean | null;

export type OperatorReadVersion = { readonly "identity": string; readonly "version": number };

export type OperatorInvocationContract = { readonly "contract_version": number; readonly "deadline_ms": number; readonly "input_schema": string; readonly "max_attempts": number; readonly "operation": string; readonly "outputs": (string)[]; readonly "settings": (OperatorInvocationSetting)[]; readonly "tools": (string)[] };

export type OperatorActionSelection = { readonly "action": string; readonly "worker": string };

export type OperatorMaterialization = { readonly "children": (OperatorMaterializedChild)[] };

export type OperatorSqlVersion = OperatorVersion | string;

export type OperatorSchemaField = { readonly "key": string; readonly "required": boolean; readonly "schema": string };

export type OperatorSchemaVariant = { readonly "key": string; readonly "schema": string };

export type OperatorCollectionDefinition = { readonly "dependencies_field": string; readonly "input_field": string; readonly "key_field": string; readonly "max_items": number; readonly "min_items": number; readonly "source": OperatorExpression };

export type OperatorPublicationPolicy = { readonly "kind": "append_revision" } | { readonly "kind": "replace_artifact" };

export type OperatorMatchCase = { readonly "node": OperatorDecisionTree; readonly "variant": string };

export type OperatorMutation = { readonly "kind": "set_state"; readonly "value": OperatorExpression } | { readonly "key": string; readonly "kind": "export"; readonly "value": OperatorExpression } | { readonly "key": string; readonly "kind": "activate_child" } | { readonly "key": string; readonly "kind": "cancel_children" } | { readonly "key": string; readonly "kind": "clear_output" } | { readonly "kind": "acquire"; readonly "pool": string } | { readonly "kind": "release"; readonly "pool": string } | { readonly "kind": "revoke"; readonly "worker": string } | { readonly "kind": "stop"; readonly "worker": string } | { readonly "key": string; readonly "kind": "bind_resource"; readonly "value": OperatorExpression } | { readonly "key": string; readonly "kind": "clear_resource" } | { readonly "kind": "observe"; readonly "resource": string };

export type OperatorActionDefinition = { readonly "contract_version": number; readonly "deadline_ms": number; readonly "input": OperatorExpression; readonly "input_schema": string; readonly "key": string; readonly "max_attempts": number; readonly "operation": string; readonly "outputs": (string)[]; readonly "prompt"?: string | null; readonly "settings": (OperatorInvocationSetting)[]; readonly "tools": (string)[] };

export type OperatorCheckedCollection = { readonly "dependencies_field": number; readonly "input_field": number; readonly "key_field": number; readonly "source": OperatorCheckedExpression };

export type OperatorCheckedExpression = { readonly "node": OperatorCheckedExpressionNode; readonly "schema": string };

export type OperatorCheckedCase = { readonly "node": OperatorCheckedTree; readonly "variant": string };

export type OperatorCheckedAction = { readonly "definition": OperatorInvocationContract; readonly "input": OperatorCheckedExpression; readonly "prompt_key"?: string | null; readonly "selection": OperatorActionSelection };

export type OperatorCheckedMutation = { readonly "kind": "set_state"; readonly "value": OperatorCheckedExpression } | { readonly "key": string; readonly "kind": "export"; readonly "value": OperatorCheckedExpression } | { readonly "key": string; readonly "kind": "activate_child" } | { readonly "key": string; readonly "kind": "cancel_children" } | { readonly "key": string; readonly "kind": "clear_output" } | { readonly "kind": "acquire"; readonly "pool": string } | { readonly "kind": "release"; readonly "pool": string } | { readonly "kind": "revoke"; readonly "worker": string } | { readonly "kind": "stop"; readonly "worker": string } | { readonly "key": string; readonly "kind": "bind_resource"; readonly "value": OperatorCheckedExpression } | { readonly "key": string; readonly "kind": "clear_resource" } | { readonly "kind": "observe"; readonly "resource": string };

export type OperatorExecutionStatus = 'pending' | 'terminal';

export type OperatorInvocationSetting = { readonly "key": string; readonly "value": string };

export type OperatorMaterializedChild = { readonly "depends_on": (string)[]; readonly "input": OperatorCheckedValue; readonly "key": string; readonly "scope": string };

export type OperatorVersion = number;

export type OperatorCheckedExpressionNode = { readonly "kind": "literal"; readonly "value": OperatorCheckedValue } | { readonly "kind": "reference"; readonly "root": OperatorReferenceRoot; readonly "selectors": (OperatorSelector)[] } | { readonly "fields": (OperatorCheckedFieldExpression)[]; readonly "kind": "record" } | { readonly "items": (OperatorCheckedExpression)[]; readonly "kind": "list" } | { readonly "kind": "variant"; readonly "value": OperatorCheckedExpression; readonly "variant": string } | { readonly "kind": "equals"; readonly "left": OperatorCheckedExpression; readonly "right": OperatorCheckedExpression } | { readonly "kind": "is_variant"; readonly "value": OperatorCheckedExpression; readonly "variant": string } | { readonly "items": (OperatorCheckedExpression)[]; readonly "kind": "all" } | { readonly "items": (OperatorCheckedExpression)[]; readonly "kind": "any" } | { readonly "kind": "not"; readonly "value": OperatorCheckedExpression } | { readonly "kind": "map"; readonly "source": OperatorCheckedExpression; readonly "value": OperatorCheckedExpression } | { readonly "kind": "optional"; readonly "value"?: OperatorCheckedExpression | null } | { readonly "index": number; readonly "kind": "field"; readonly "value": OperatorCheckedExpression } | { readonly "key": OperatorCheckedExpression; readonly "key_field": number; readonly "kind": "filter_by"; readonly "source": OperatorCheckedExpression } | { readonly "kind": "contains"; readonly "source": OperatorCheckedExpression; readonly "value": OperatorCheckedExpression } | { readonly "key": OperatorCheckedExpression; readonly "key_field": number; readonly "kind": "lookup"; readonly "source": OperatorCheckedExpression } | { readonly "kind": "filter"; readonly "predicate": OperatorCheckedExpression; readonly "source": OperatorCheckedExpression } | { readonly "key_field": number; readonly "kind": "unique_by"; readonly "source": OperatorCheckedExpression } | { readonly "dependencies_field": number; readonly "key_field": number; readonly "kind": "check_collection"; readonly "source": OperatorCheckedExpression } | { readonly "kind": "every"; readonly "predicate": OperatorCheckedExpression; readonly "source": OperatorCheckedExpression };

export type OperatorSelector = { readonly "index": number; readonly "kind": "field" } | { readonly "index": number; readonly "kind": "optional_field"; readonly "schema": string } | { readonly "kind": "optional" } | { readonly "kind": "variant"; readonly "variant": string };

export type OperatorCheckedFieldExpression = { readonly "field_id": number; readonly "value": OperatorCheckedExpression };
