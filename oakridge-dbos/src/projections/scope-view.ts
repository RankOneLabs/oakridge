import type { CheckedValue, CommandDefinition, DefinitionBundle, DecisionOutcome } from "../core-client/generated-contracts";
import type { ScopeId, ScopeInstanceRecord, ExecutionRecord, OutputSlotRecord, ArtifactRevisionRecord, ResourceBindingRecord } from "../storage/schema-records";
import type { TransactionalSqlExecutor } from "../storage/sql-executor";
import { availableCommand, currentTargetRevisions, type TargetRevision } from "../storage/command-selection";
import { readScopeObservations } from "../storage/snapshot-reader";
import { normalizeExecutionRecord, normalizeRecordVersion, type StoredExecutionRecord, type StoredVersionedRecord } from "./record-selectors";

export interface ProjectionCursor { readonly scope_version: number; readonly transition_id: string | null }
export interface OutputSlotView extends OutputSlotRecord { readonly current_revision: ArtifactRevisionRecord | null }
interface StoredOutputSlotView extends OutputSlotRecord { readonly current_revision: StoredVersionedRecord<ArtifactRevisionRecord> | null }
function normalizeOutputSlot(row: StoredVersionedRecord<StoredOutputSlotView>): OutputSlotView {
  return { ...normalizeRecordVersion(row), current_revision: row.current_revision ? normalizeRecordVersion(row.current_revision) : null };
}
export interface ScopeView {
  readonly scope_id: ScopeId; readonly run_id: string; readonly scope_key: string; readonly label: string;
  readonly state: CheckedValue; readonly outcome: CheckedValue | null; readonly is_terminal: boolean;
  readonly commands: readonly CommandDefinition[]; readonly executions: readonly ExecutionRecord[];
  readonly outputs: readonly OutputSlotView[]; readonly resources: readonly ResourceBindingRecord[];
  readonly command_targets: Readonly<{ readonly [command_key: string]: readonly TargetRevision[] }>;
  readonly decision: DecisionOutcome | null; readonly cursor: ProjectionCursor;
}
interface TransitionRow { readonly id: string; readonly decision: DecisionOutcome }
export function selectAvailableCommands(bundle: DefinitionBundle, scope: ScopeInstanceRecord): readonly CommandDefinition[] {
  return bundle.scopes.find((item) => item.key === scope.scope_key)?.commands.filter((item) =>
    !scope.is_terminal && availableCommand(bundle, scope.scope_key, scope.local_state, item.key) !== null) ?? [];
}
export async function readScopeView(db: TransactionalSqlExecutor, scope_id: ScopeId): Promise<ScopeView | null> {
  return db.transaction(async (tx) => {
    const scope = (await tx.query<ScopeInstanceRecord>("SELECT * FROM authority.scope_instance WHERE id=$1", [scope_id]))[0];
    if (!scope) return null;
    const bundle = (await tx.query<{ source: DefinitionBundle }>("SELECT b.source FROM authority.definition_bundle b JOIN authority.run r ON r.definition_bundle_id=b.id WHERE r.id=$1", [scope.run_id]))[0]?.source;
    if (!bundle) throw new Error(`pinned definition missing for ${scope.run_id}`);
    const definition = bundle.scopes.find((item) => item.key === scope.scope_key);
    if (!definition) throw new Error(`scope definition missing for ${scope.id}`);
    const [executions, outputs, resources, transitions] = await Promise.all([
      tx.query<StoredExecutionRecord>("SELECT * FROM authority.execution WHERE scope_id=$1 ORDER BY id", [scope.id]),
      tx.query<StoredVersionedRecord<StoredOutputSlotView>>("SELECT s.*, row_to_json(r) AS current_revision FROM authority.output_slot s LEFT JOIN authority.artifact_revision r ON r.id=s.current_revision_id AND r.scope_id=s.scope_id WHERE s.scope_id=$1 ORDER BY s.id", [scope.id]),
      tx.query<StoredVersionedRecord<ResourceBindingRecord>>("SELECT * FROM authority.resource_binding WHERE scope_id=$1 ORDER BY id", [scope.id]),
      tx.query<TransitionRow>("SELECT id,decision FROM authority.transition WHERE scope_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1", [scope.id]),
    ]);
    const commands = selectAvailableCommands(bundle, scope);
    const observations = await readScopeObservations(tx, { owner: scope, scope: definition, bundle });
    const command_targets = Object.fromEntries(await Promise.all(commands.map(async (command) =>
      [command.key, await currentTargetRevisions(tx, scope_id, command, observations)] as const)));
    return { scope_id, run_id: scope.run_id, scope_key: scope.scope_key, label: definition.presentation.label,
      state: scope.local_state, outcome: scope.outcome, is_terminal: scope.is_terminal,
      commands, command_targets, executions: executions.map(normalizeExecutionRecord),
      outputs: outputs.map(normalizeOutputSlot), resources: resources.map(normalizeRecordVersion),
      decision: transitions[0]?.decision ?? null,
      cursor: { scope_version: Number(scope.version), transition_id: transitions[0]?.id ?? null } };
  }, "repeatable read");
}
