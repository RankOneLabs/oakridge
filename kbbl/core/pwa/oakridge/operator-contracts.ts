// Generated from oakridge-dbos projections. Run kbbl/scripts/generate-operator-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.
import type { OperatorCheckedValue, OperatorCommandDescriptor, OperatorScopeView, OperatorOutputSlot, OperatorTargetRevision } from "./operator-contracts.base";
export type * from "./operator-contracts.base";

export interface OperatorResourceBinding { readonly id: string; readonly version: number; readonly scope_id: string; readonly resource_key: string; readonly observation: OperatorCheckedValue | null }

export interface OperatorRunScopeSummary { readonly scope_id: string; readonly scope_key: string; readonly label: string; readonly version: number; readonly is_terminal: boolean; readonly available_commands: readonly string[] }

export interface OperatorRunView { readonly run_id: string; readonly definition_bundle_id: string; readonly definition_digest: string; readonly version: number; readonly cursor: readonly { readonly scope_id: string; readonly version: number }[]; readonly scopes: readonly OperatorRunScopeSummary[] }

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
export interface OperatorDefinitionSummary { readonly bundle_id: string; readonly digest: string; readonly source: import("./workflow-definition-types").WorkflowDefinitionDescriptor }
