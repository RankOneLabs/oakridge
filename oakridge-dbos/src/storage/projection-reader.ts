import type { DefinitionBundle } from "../core-client/generated-contracts";
import type { TransactionalSqlExecutor } from "./sql-executor";
import type { RunId, RunRecord, ScopeId, ScopeInstanceRecord, ResourceBindingRecord } from "./schema-records";
import { readScopeObservations } from "./snapshot-reader";
import { currentTargetRevisions } from "./command-selection";
import { normalizeExecutionRecord, normalizeRecordVersion, type StoredExecutionRecord, type StoredVersionedRecord } from "../projections/record-selectors";
import { normalizeOutputSlot, selectAvailableCommands, type ScopeView, type StoredOutputSlotView, type TransitionRow } from "../projections/scope-view";
import { selectInboxItems, type InboxItem, type InboxRow } from "../projections/inbox";
import type { RunView } from "../projections/run-view";

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
    const { observations } = await readScopeObservations(tx, { owner: scope, scope: definition, bundle });
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

export async function readInbox(db: TransactionalSqlExecutor): Promise<{ readonly cursor: readonly { readonly scope_id: string; readonly version: number }[]; readonly items: readonly InboxItem[] }> {
  return db.transaction(async (tx) => {
    const rows = await tx.query<InboxRow>(`SELECT s.*, b.source,
      (SELECT t.decision FROM authority.transition t WHERE t.scope_id=s.id ORDER BY t.created_at DESC,t.id DESC LIMIT 1) AS decision,
      (SELECT jsonb_agg(jsonb_build_object('fact_key', f.fact_key) ORDER BY f.id) FROM authority.fact f WHERE f.scope_id=s.id) AS diagnostics
      FROM authority.scope_instance s JOIN authority.run r ON r.id=s.run_id
      LEFT JOIN authority.definition_bundle b ON b.id=r.definition_bundle_id ORDER BY s.run_id,s.id`, []);
    return { cursor: rows.map((row) => ({ scope_id: row.id, version: Number(row.version) })), items: rows.flatMap(selectInboxItems) };
  }, "repeatable read");
}

export async function readRunView(db: TransactionalSqlExecutor, run_id: RunId): Promise<RunView | null> {
  return db.transaction(async (tx) => {
    const run = (await tx.query<RunRecord>("SELECT * FROM authority.run WHERE id=$1", [run_id]))[0];
    if (!run) return null;
    const pinned = (await tx.query<{ source: DefinitionBundle; digest: string }>("SELECT source,digest FROM authority.definition_bundle WHERE id=$1", [run.definition_bundle_id]))[0];
    if (!pinned) throw new Error(`pinned definition missing for ${run_id}`);
    const scopes = await tx.query<ScopeInstanceRecord>("SELECT * FROM authority.scope_instance WHERE run_id=$1 ORDER BY id", [run_id]);
    return { run_id, definition_bundle_id: run.definition_bundle_id, definition_digest: pinned.digest, version: Number(run.version),
      cursor: scopes.map((scope) => ({ scope_id: scope.id, version: Number(scope.version) })),
      scopes: scopes.map((scope) => ({ scope_id: scope.id, scope_key: scope.scope_key,
        label: pinned.source.scopes.find((item) => item.key === scope.scope_key)?.presentation.label ?? scope.scope_key,
        version: Number(scope.version), is_terminal: scope.is_terminal,
        available_commands: selectAvailableCommands(pinned.source, scope).map((item) => item.key) })) };
  }, "repeatable read");
}
