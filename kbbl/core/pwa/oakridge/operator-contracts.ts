// Generated from oakridge-dbos projections. Run kbbl/scripts/generate-operator-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.
export interface OperatorLaunchRequest { readonly digest: string; readonly input: unknown; readonly request_id: string }

export interface OperatorLaunchedRun { readonly run_id: string; readonly root_scope_id: string; readonly bundle_id: string }

export interface OperatorRunScopeSummary { readonly scope_id: string; readonly scope_key: string; readonly label: string; readonly version: number; readonly is_terminal: boolean; readonly available_commands: readonly string[] }

export interface OperatorRunView { readonly run_id: string; readonly definition_bundle_id: string; readonly definition_digest: string; readonly version: number; readonly cursor: readonly { readonly scope_id: string; readonly version: number }[]; readonly scopes: readonly OperatorRunScopeSummary[] }

export interface OperatorDefinitionSummary { readonly bundle_id: string; readonly digest: string; readonly source: import("./workflow-definition-types").WorkflowDefinitionDescriptor }

export interface OperatorResourceBinding { readonly id: string; readonly version: number; readonly scope_id: string; readonly resource_key: string; readonly observation: OperatorCheckedValue | null }

export type OperatorSchemaShape =
  | { readonly kind: "boolean" }
  | { readonly kind: "integer"; readonly min: number; readonly max: number }
  | { readonly kind: "string"; readonly min_length: number; readonly max_length: number }
  | { readonly kind: "enum"; readonly variants: readonly string[] }
  | { readonly kind: "record"; readonly fields: readonly OperatorSchemaField[]; readonly dictionary?: string | null }
  | { readonly kind: "list"; readonly item: string; readonly max_items: number }
  | { readonly kind: "optional"; readonly item: string }
  | { readonly kind: "union"; readonly variants: readonly { readonly key: string; readonly schema: string }[] }
  | { readonly kind: "reference"; readonly brand: "instance" | "execution" | "artifact_revision" | "resource" };

export interface OperatorSchemaField { readonly key: string; readonly schema: string; readonly required: boolean }

export interface OperatorSchema { readonly key: string; readonly shape: OperatorSchemaShape }

export interface OperatorPresentation { readonly label: string; readonly viewer?: string | null }

export interface OperatorCommandDescriptor {
  readonly key: string; readonly label: string; readonly consequence: string; readonly payload_schema: string;
  readonly field_presentation: readonly { readonly key: string; readonly presentation: OperatorPresentation }[];
  readonly targets: readonly unknown[];
}

export interface OperatorScopeDefinition {
  readonly key: string; readonly presentation: OperatorPresentation;
  readonly commands: readonly OperatorCommandDescriptor[];
  readonly outputs: readonly { readonly key: string; readonly schema: string }[];
}

export interface OperatorPinnedDefinition {
  readonly bundle_id: string; readonly digest: string;
  readonly source: { readonly root: string; readonly schemas: readonly OperatorSchema[]; readonly scopes: readonly OperatorScopeDefinition[] };
}

export interface OperatorGenericRun {
  readonly run_id: string; readonly scopes: readonly { readonly scope_id: string; readonly scope_key: string; readonly label: string;
    readonly version: number; readonly is_terminal: boolean; readonly available_commands: readonly string[] }[];
}

export interface OperatorCheckedValue { readonly schema: string; readonly data: OperatorCheckedData }

export type OperatorCheckedData =
  | { readonly kind: "boolean" | "integer" | "string"; readonly value: boolean | number | string }
  | { readonly kind: "enum"; readonly variant: string }
  | { readonly kind: "record"; readonly fields: readonly { readonly field_id: number; readonly value: OperatorCheckedValue | null }[]; readonly dictionary: readonly { readonly key: string; readonly value: OperatorCheckedValue }[] }
  | { readonly kind: "list"; readonly items: readonly OperatorCheckedValue[] }
  | { readonly kind: "optional"; readonly value?: OperatorCheckedValue | null }
  | { readonly kind: "variant"; readonly variant: string; readonly value: OperatorCheckedValue }
  | { readonly kind: "reference"; readonly brand: string; readonly id: string };

export interface OperatorTargetRevision { readonly identity: string; readonly version: number }

export interface OperatorArtifactRevision {
  readonly id: string; readonly version: number; readonly scope_id: string; readonly execution_id: string | null;
  readonly output_key: string; readonly collection_key: string | null; readonly body: OperatorCheckedValue;
  readonly predecessor_id: string | null;
}

export interface OperatorOutputSlot {
  readonly id: string; readonly version: number; readonly output_key: string; readonly collection_key: string;
  readonly current_revision_id: string | null; readonly current_revision: OperatorArtifactRevision | null;
}

export interface OperatorScopeView {
  readonly scope_id: string; readonly run_id: string; readonly scope_key: string; readonly label: string;
  readonly state: OperatorCheckedValue; readonly outcome: OperatorCheckedValue | null; readonly is_terminal: boolean;
  readonly commands: readonly OperatorCommandDescriptor[];
  readonly outputs: readonly OperatorOutputSlot[];
  readonly executions: readonly { readonly id: string; readonly version: number; readonly worker_key: string; readonly status: string; readonly result: OperatorCheckedValue | null }[];
  readonly cursor: { readonly scope_version: number; readonly transition_id: string | null };
  /** m5-generic-api supplies observed revision identities for each available command. */
  readonly command_targets?: Readonly<{ readonly [commandKey: string]: readonly OperatorTargetRevision[] }>;
}

export interface OperatorDraftKey { readonly run_id: string; readonly scope_id: string; readonly command_key: string;
  readonly owner_version: number; readonly targets: readonly OperatorTargetRevision[] }

export interface OperatorCommandSubmission extends OperatorDraftKey {
  readonly request_id: string; readonly payload: unknown;
}

export interface OperatorCommandReceipt { readonly kind: "accepted_pending"; readonly request_id: string;
  readonly transition_id: string; readonly scope_version: number }

export type OperatorInboxItem =
  | { readonly kind: "command"; readonly run_id: string; readonly scope_id: string; readonly scope_version: number; readonly key: string; readonly label: string; readonly consequence: string }
  | { readonly kind: "wait"; readonly run_id: string; readonly scope_id: string; readonly scope_version: number; readonly reason: string; readonly label: string }
  | { readonly kind: "diagnostic"; readonly run_id: string; readonly scope_id: string; readonly scope_version: number; readonly detail: string };

export interface OperatorInbox { readonly cursor: readonly { readonly scope_id: string; readonly version: number }[]; readonly items: readonly OperatorInboxItem[] }

export interface OperatorInboxPage extends OperatorInbox { readonly next_cursor: string | null }

export interface OperatorProjectionCursor { readonly scope_version: number; readonly transition_id: string | null }

export interface OperatorScopeProjection {
  readonly scope_id: string; readonly run_id: string; readonly scope_key: string; readonly label: string;
  readonly state: OperatorCheckedValue; readonly outcome: OperatorCheckedValue | null; readonly is_terminal: boolean;
  readonly commands: readonly OperatorCommandDescriptor[]; readonly executions: readonly OperatorScopeView["executions"][number][];
  readonly outputs: readonly OperatorOutputSlot[]; readonly resources: readonly OperatorResourceBinding[];
  readonly command_targets: Readonly<{ readonly [command_key: string]: readonly OperatorTargetRevision[] }>;
  readonly decision: unknown | null; readonly cursor: OperatorProjectionCursor;
}

export interface OperatorStoredTransitionHistory<Timestamp = string> {
  readonly id: string; readonly trigger_id: string; readonly decision: unknown;
  readonly created_at: Timestamp; readonly version: number | string;
}

export interface OperatorTransitionHistory<Timestamp = string> extends Omit<OperatorStoredTransitionHistory<Timestamp>, "version"> { readonly version: number }

export interface OperatorScopeFactHistory { readonly id: string; readonly fact_key: string; readonly payload: OperatorCheckedValue }

export interface OperatorScopeHistory {
  readonly scope_id: string;
  readonly transitions: readonly OperatorTransitionHistory[];
  readonly facts: readonly OperatorScopeFactHistory[];
}
