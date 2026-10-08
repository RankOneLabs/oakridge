import type { CheckedValue, CommandDefinition, DefinitionBundle, DecisionOutcome } from "../core-client/generated-contracts";
import type { ScopeId, ScopeInstanceRecord, OutputSlotRecord, ArtifactRevisionRecord, ResourceBindingRecord } from "../storage/schema-records";
import type { TargetRevision } from "../storage/command-selection";
import { normalizeRecordVersion, type ExecutionView, type StoredVersionedRecord } from "./record-selectors";

export interface ProjectionCursor { readonly scope_version: number; readonly transition_id: string | null }
export interface OperatorResourceBinding { readonly id: string; readonly version: number; readonly scope_id: string; readonly resource_key: string; readonly observation: OperatorCheckedValue | null }
export interface OutputSlotView extends OutputSlotRecord { readonly current_revision: ArtifactRevisionRecord | null }
export interface StoredOutputSlotView extends OutputSlotRecord { readonly current_revision: StoredVersionedRecord<ArtifactRevisionRecord> | null }
export function normalizeOutputSlot(row: StoredVersionedRecord<StoredOutputSlotView>): OutputSlotView {
  return { ...normalizeRecordVersion(row), current_revision: row.current_revision ? normalizeRecordVersion(row.current_revision) : null };
}
export interface ScopeView {
  readonly scope_id: ScopeId; readonly run_id: string; readonly scope_key: string; readonly label: string;
  readonly state: CheckedValue; readonly outcome: CheckedValue | null; readonly is_terminal: boolean;
  readonly commands: readonly CommandDefinition[]; readonly executions: readonly ExecutionView[];
  readonly outputs: readonly OutputSlotView[]; readonly resources: readonly ResourceBindingRecord[];
  readonly command_targets: Readonly<{ readonly [command_key: string]: readonly TargetRevision[] }>;
  readonly decision: DecisionOutcome | null; readonly cursor: ProjectionCursor;
}
export interface TransitionRow { readonly id: string; readonly decision: DecisionOutcome }
export function selectAvailableCommands(bundle: DefinitionBundle, scope: ScopeInstanceRecord): readonly CommandDefinition[] {
  return bundle.scopes.find((item) => item.key === scope.scope_key)?.commands.filter((item) =>
    !scope.is_terminal && availableCommand(bundle, scope.scope_key, scope.local_state, item.key) !== null) ?? [];
}

export function availableCommand(definition: DefinitionBundle, scope_key: string, state: CheckedValue, command_key: string): CommandDefinition | null {
  const command = definition.scopes.find((scope) => scope.key === scope_key)?.commands.find((item) => item.key === command_key);
  if (!command) return null;
  const state_key = state.data.kind === "variant" ? state.data.variant : state.data.kind === "enum" ? state.data.variant : null;
  return command.available_in.length === 0 || (state_key !== null && command.available_in.includes(state_key)) ? command : null;
}

// Public operator wire shapes mirrored from the pinned definition and scope projection.
/** Mirrors oakridge-dbos definition bundle, run/scope projections and scope command HTTP contract. */
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
/** Mirrors authority.artifact_revision in the scope projection. */
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
