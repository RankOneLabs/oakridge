import type { CheckedValue, CommandDefinition, DefinitionBundle, DecisionOutcome } from "../core-client/generated-contracts";
import type { ScopeId, ScopeInstanceRecord, OutputSlotRecord, ArtifactRevisionRecord, ResourceBindingRecord } from "../storage/schema-records";
import type { CommandPrefill, TargetRevision } from "../storage/command-selection";
import { normalizeRecordVersion, type ExecutionView, type StoredVersionedRecord } from "./record-selectors";

export interface ProjectionCursor { readonly scope_version: number; readonly transition_id: string | null }
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
  readonly command_prefill: Readonly<{ readonly [command_key: string]: CommandPrefill }>;
  readonly decision: DecisionOutcome | null; readonly cursor: ProjectionCursor;
}
export interface TransitionRow { readonly id: string; readonly decision: DecisionOutcome }
export function selectAvailableCommands(bundle: DefinitionBundle, scope: ScopeInstanceRecord): readonly CommandDefinition[] {
  const definition = bundle.scopes.find((item) => item.key === scope.scope_key);
  const publication_triggers = new Set(definition?.outputs?.flatMap((output) => output.operator_edit_trigger ? [output.operator_edit_trigger] : []) ?? []);
  return definition?.commands.filter((item) => !publication_triggers.has(item.key)
    && !scope.is_terminal && availableCommand(bundle, scope.scope_key, scope.local_state, item.key) !== null) ?? [];
}

export function availableCommand(definition: DefinitionBundle, scope_key: string, state: CheckedValue, command_key: string): CommandDefinition | null {
  const command = definition.scopes.find((scope) => scope.key === scope_key)?.commands.find((item) => item.key === command_key);
  if (!command) return null;
  const state_key = state.data.kind === "variant" ? state.data.variant : state.data.kind === "enum" ? state.data.variant : null;
  return command.available_in.length === 0 || (state_key !== null && command.available_in.includes(state_key)) ? command : null;
}
