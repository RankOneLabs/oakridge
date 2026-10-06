import type { CoreClient } from "../core-client/client";
import type { DefinitionBundle } from "../core-client/generated-contracts";
import type { MutationService } from "../storage/mutation-service";
import type { ChildCollectionRecord, RunId, ScopeId, ScopeInstanceRecord, ScopeExportRecord } from "../storage/schema-records";
import type { TransactionalSqlExecutor } from "../storage/sql-executor";

interface RunBundle { readonly run_id: RunId; readonly source: DefinitionBundle }
export interface LifecycleFailure { readonly scope_id: string; readonly detail: string }
export interface ChildAdvancementInput {
  readonly db: TransactionalSqlExecutor;
  readonly core: CoreClient;
  readonly mutations: MutationService;
  /** Omitted for periodic recovery of all active runs. */
  readonly run_ids?: readonly RunId[];
}
function groupChildCollections(collections: readonly ChildCollectionRecord[]): ReadonlyMap<ScopeId, readonly ChildCollectionRecord[]> {
  const grouped = new Map<ScopeId, ChildCollectionRecord[]>();
  for (const collection of collections) {
    const siblings = grouped.get(collection.scope_id) ?? [];
    siblings.push(collection);
    grouped.set(collection.scope_id, siblings);
  }
  return grouped;
}

/**
 * Entry and completion triggers are declared in the bundle and delivered through
 * receipts. A scope whose trigger is rejected is reported, not thrown: one bad
 * scope never stops the others in the same pass.
 */
export async function advanceChildren({ db, core, mutations, run_ids }: ChildAdvancementInput): Promise<readonly LifecycleFailure[]> {
  const failures: LifecycleFailure[] = [];
  const report = (scope_id: string, error: unknown): void => { failures.push({ scope_id, detail: error instanceof Error ? error.message : String(error) }); };
  const runs = await db.query<RunBundle>(`SELECT r.id AS run_id,b.source FROM authority.run r
    JOIN authority.definition_bundle b ON b.id=r.definition_bundle_id
    WHERE ($1::text[] IS NULL OR r.id=ANY($1)) AND EXISTS (
      SELECT 1 FROM authority.scope_instance root WHERE root.run_id=r.id AND root.parent_id IS NULL AND NOT root.is_terminal
    ) ORDER BY r.id`, [run_ids ?? null]);
  if (!runs.length) return failures;
  const active_run_ids = runs.map((run) => run.run_id);
  const bundles = new Map(runs.map((run) => [run.run_id, run.source]));
  const scopes = await db.query<ScopeInstanceRecord>("SELECT * FROM authority.scope_instance WHERE run_id=ANY($1::text[]) ORDER BY id", [active_run_ids]);
  const scopes_by_id = new Map(scopes.map((scope) => [scope.id, scope]));
  const all_collections = await db.query<ChildCollectionRecord>(`SELECT c.* FROM authority.child_collection c
    JOIN authority.scope_instance s ON s.id=c.scope_id WHERE s.run_id=ANY($1::text[]) ORDER BY c.id`, [active_run_ids]);
  const collections_by_parent = groupChildCollections(all_collections);
  const exports = await db.query<ScopeExportRecord>(`SELECT e.* FROM authority.scope_export e
    JOIN authority.scope_instance s ON s.id=e.scope_id WHERE s.run_id=ANY($1::text[]) ORDER BY e.id`, [active_run_ids]);
  for (const scope of scopes) {
    try { await advanceScope(scope); } catch (error) { report(scope.id, error); }
  }
  const empty_collections = all_collections.filter((collection) => collection.members.length === 0);
  for (const collection of empty_collections) {
    const parent = scopes_by_id.get(collection.scope_id);
    if (!parent || parent.is_terminal) continue;
    const definition = bundles.get(parent.run_id)?.scopes.find((item) => item.key === parent.scope_key);
    const child = definition?.children.find((item) => item.key === collection.collection_key);
    const fact = definition?.facts.find((item) => item.key === child?.on_terminal);
    if (!fact) continue;
    try { await deliver(parent, fact.key, `empty-collection:${collection.id}`, fact.payload_schema); } catch (error) { report(parent.id, error); }
  }
  return failures;

  async function advanceScope(scope: ScopeInstanceRecord): Promise<void> {
    const bundle = bundles.get(scope.run_id);
    const definition = bundle?.scopes.find((item) => item.key === scope.scope_key);
    const parent = scope.parent_id ? scopes_by_id.get(scope.parent_id) : undefined;
    const parent_definition = bundle?.scopes.find((item) => item.key === parent?.scope_key);
    let child = parent_definition?.children.find((item) => item.key === scope.collection_key || (!scope.collection_key && item.key === scope.child_key));
    let dependencies: readonly string[] = child?.depends_on ?? [];
    const collections = parent ? collections_by_parent.get(parent.id as ScopeId) ?? [] : [];
    if (parent && (!child || scope.collection_key)) {
      for (const collection of collections) {
        const member = collection.members.find((member) => typeof member === "string" ? member === scope.id : member.id === scope.id);
        if (!member) continue;
        child = parent_definition?.children.find((item) => item.key === collection.collection_key);
        dependencies = typeof member === "string" ? [] : member.depends_on;
        break;
      }
    }
    if (!scope.is_terminal && definition?.entry_command && (!parent || !parent.is_terminal)) {
      const required = dependencies.flatMap((key) => {
        const collection = collections.find((item) => item.collection_key === key);
        if (!collection) return [scopes.find((item) => item.parent_id === parent?.id && item.child_key === key && (item.collection_key ?? null) === (scope.collection_key ?? null))];
        return collection.members.map((member) => scopes_by_id.get(typeof member === "string" ? member : member.id));
      });
      if (required.some((item) => !item?.is_terminal)) return;
      if (child?.prerequisite_export && required.length) {
        const succeeded = required.every((dependency) => exports.some((item) => item.scope_id === dependency?.id && item.export_key === child?.prerequisite_export && item.value.data.kind === "boolean" && item.value.data.value));
        if (!succeeded) {
          const cancellation = definition.cancellation.trigger;
          const event = definition.commands.find((item) => item.key === cancellation) ?? definition.facts.find((item) => item.key === cancellation);
          if (event) await deliver(scope, event.key, `dependency-cancel:${scope.id}`, event.payload_schema);
          return;
        }
      }
      const key = definition.entry_command;
      const command = definition.commands.find((item) => item.key === key);
      if (!command) return;
      const state = scope.local_state.data.kind === "variant" || scope.local_state.data.kind === "enum" ? scope.local_state.data.variant : null;
      if (!state || !command.available_in.includes(state)) return;
      await deliver(scope, key, `entry:${scope.id}`, command.payload_schema);
    }
    if (scope.is_terminal && parent && !parent.is_terminal && child?.on_terminal) {
      const fact = parent_definition?.facts.find((fact) => fact.key === child?.on_terminal);
      if (fact) await deliver(parent, fact.key, `child-terminal:${scope.id}`, fact.payload_schema);
    }
  }
  async function deliver(scope: ScopeInstanceRecord, key: string, id: string, schema: string): Promise<void> {
    const bundle = bundles.get(scope.run_id);
    if (!bundle) throw new Error(`lifecycle bundle missing: ${scope.run_id}`);
    const checked = await core.request("validate_payload", { bundle, schema, payload: {} });
    if (!checked.ok || checked.value.kind !== "validated") throw new Error(`invalid configured lifecycle payload: ${scope.id}/${key}`);
    const result = await mutations.decide({ run_id: scope.run_id, scope_id: scope.id as ScopeId, ingress_id: id,
      trigger: { id, key, payload: checked.value.value }, operator_version: null });
    if (!result.ok) throw new Error(`${result.error.operation}/${result.error.entity_id}: ${result.error.detail}`);
    const outcome = result.value;
    switch (outcome.kind) {
      case "Committed": case "Replayed": case "Conflict": return;
      case "Rejected":
        if (outcome.detail === "owner is terminal" || outcome.detail.startsWith("apply_capacity/")) return;
        throw new Error(outcome.detail);
      case "snapshot_too_large":
        throw new Error(`snapshot_too_large: ${outcome.scope} ${outcome.bytes}/${outcome.limit}`);
      default: { const unhandled: never = outcome; throw new Error(`unhandled commit outcome: ${JSON.stringify(unhandled)}`); }
    }
  }
}
