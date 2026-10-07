import type { CompiledBundle, DefinitionBundle } from "../core-client/generated-contracts";
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
    const pinned = (await tx.query<{ source: DefinitionBundle; checked_program: CompiledBundle }>("SELECT b.source,b.checked_program FROM authority.definition_bundle b JOIN authority.run r ON r.definition_bundle_id=b.id WHERE r.id=$1", [scope.run_id]))[0];
    const bundle = pinned?.source;
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
    const reads = pinned?.checked_program.scopes.find((item) => item.key === scope.scope_key)?.reads;
    if (!reads) throw new Error(`checked scope missing for ${scope.id}`);
    const { observations } = await readScopeObservations(tx, { owner: scope, scope: definition, bundle, reads });
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

export const DEFAULT_INBOX_LIMIT = 100;
export interface InboxQuery { readonly run_id?: RunId; readonly cursor?: string; readonly limit?: number }
interface InboxScopeRow extends Omit<InboxRow, "source"> { readonly definition_bundle_id: string }
export async function readInbox(db: TransactionalSqlExecutor, query: InboxQuery = {}): Promise<{ readonly cursor: readonly { readonly scope_id: string; readonly version: number }[]; readonly items: readonly InboxItem[]; readonly next_cursor: string | null }> {
  const limit = Math.min(Math.max(1, query.limit ?? DEFAULT_INBOX_LIMIT), DEFAULT_INBOX_LIMIT);
  const after = query.cursor ? JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")) as readonly [string, string] : null;
  if (after && (!Array.isArray(after) || after.length !== 2 || after.some((item) => typeof item !== "string"))) throw new Error("invalid inbox cursor");
  return db.transaction(async (tx) => {
    const rows = await tx.query<InboxScopeRow>(`SELECT s.*, r.definition_bundle_id,
      (SELECT t.decision FROM authority.transition t WHERE t.scope_id=s.id ORDER BY t.created_at DESC,t.id DESC LIMIT 1) AS decision,
      (SELECT jsonb_agg(jsonb_build_object('fact_key', f.fact_key) ORDER BY f.id) FROM authority.fact f WHERE f.scope_id=s.id) AS diagnostics
      FROM authority.scope_instance s JOIN authority.run r ON r.id=s.run_id
      WHERE ($1::text IS NULL OR s.run_id=$1) AND ($2::text IS NULL OR (s.run_id,s.id)>($2,$3))
      ORDER BY s.run_id,s.id LIMIT $4`, [query.run_id ?? null, after?.[0] ?? null, after?.[1] ?? null, limit + 1]);
    const page = rows.slice(0, limit);
    const bundle_ids = [...new Set(page.map((row) => row.definition_bundle_id))];
    const bundles = bundle_ids.length ? await tx.query<{ id: string; source: DefinitionBundle }>(
      "SELECT id,source FROM authority.definition_bundle WHERE id=ANY($1::text[])", [bundle_ids]) : [];
    const sources = new Map(bundles.map((bundle) => [bundle.id, bundle.source]));
    const last = page.at(-1);
    return { cursor: page.map((row) => ({ scope_id: row.id, version: Number(row.version) })),
      items: page.flatMap((row) => selectInboxItems({ ...row, source: sources.get(row.definition_bundle_id) ?? null })),
      next_cursor: rows.length > limit && last ? Buffer.from(JSON.stringify([last.run_id, last.id])).toString("base64url") : null };
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
