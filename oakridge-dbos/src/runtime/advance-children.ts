import type { CoreClient } from "../core-client/client";
import type { DefinitionBundle } from "../core-client/generated-contracts";
import type { MutationService } from "../storage/mutation-service";
import type { ChildCollectionRecord, ScopeId, ScopeInstanceRecord, ScopeExportRecord } from "../storage/schema-records";
import type { TransactionalSqlExecutor } from "../storage/sql-executor";

interface RunnableScope extends ScopeInstanceRecord { readonly source: DefinitionBundle }

/** Entry and completion triggers are declared in the bundle and delivered through receipts. */
export async function advanceChildren(db: TransactionalSqlExecutor, core: CoreClient, mutations: MutationService): Promise<void> {
  const scopes = await db.query<RunnableScope>(`SELECT s.*,b.source FROM authority.scope_instance s
    JOIN authority.run r ON r.id=s.run_id JOIN authority.definition_bundle b ON b.id=r.definition_bundle_id
    ORDER BY s.id`, []);
  for (const scope of scopes) {
    const definition = scope.source.scopes.find((item) => item.key === scope.scope_key);
    const parent = scopes.find((item) => item.id === scope.parent_id);
    const parent_definition = scope.source.scopes.find((item) => item.key === parent?.scope_key);
    let child = parent_definition?.children.find((item) => item.key === scope.collection_key || (!scope.collection_key && item.key === scope.child_key));
    let dependencies: readonly string[] = child?.depends_on ?? [];
    const collections = parent ? await db.query<ChildCollectionRecord>("SELECT * FROM authority.child_collection WHERE scope_id=$1 ORDER BY id", [parent.id]) : [];
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
        return collection.members.map((member) => scopes.find((item) => item.id === (typeof member === "string" ? member : member.id)));
      });
      if (required.some((item) => !item?.is_terminal)) continue;
      if (child?.prerequisite_export && required.length) {
        const exports = await db.query<ScopeExportRecord>("SELECT * FROM authority.scope_export WHERE scope_id=ANY($1::text[]) AND export_key=$2", [required.map((item) => item?.id), child.prerequisite_export]);
        const succeeded = required.every((dependency) => exports.some((item) => item.scope_id === dependency?.id && item.value.data.kind === "boolean" && item.value.data.value));
        if (!succeeded) {
          const cancellation = definition.cancellation.trigger;
          const event = definition.commands.find((item) => item.key === cancellation) ?? definition.facts.find((item) => item.key === cancellation);
          if (event) await deliver(scope, event.key, `dependency-cancel:${scope.id}`, event.payload_schema);
          continue;
        }
      }
      const key = definition.entry_command;
      const command = definition.commands.find((item) => item.key === key);
      if (!command) continue;
      const state = scope.local_state.data.kind === "variant" || scope.local_state.data.kind === "enum" ? scope.local_state.data.variant : null;
      if (!state || !command.available_in.includes(state)) continue;
      await deliver(scope, key, `entry:${scope.id}`, command.payload_schema);
    }
    if (scope.is_terminal && parent && !parent.is_terminal && child?.on_terminal) {
      const fact = parent_definition?.facts.find((fact) => fact.key === child?.on_terminal);
      if (fact) await deliver(parent, fact.key, `child-terminal:${scope.id}`, fact.payload_schema);
    }
  }
  const empty_collections = await db.query<ChildCollectionRecord>("SELECT * FROM authority.child_collection WHERE members='[]'::jsonb ORDER BY id", []);
  for (const collection of empty_collections) {
    const parent = scopes.find((item) => item.id === collection.scope_id);
    if (!parent || parent.is_terminal) continue;
    const definition = parent.source.scopes.find((item) => item.key === parent.scope_key);
    const child = definition?.children.find((item) => item.key === collection.collection_key);
    const fact = definition?.facts.find((item) => item.key === child?.on_terminal);
    if (fact) await deliver(parent, fact.key, `empty-collection:${collection.id}`, fact.payload_schema);
  }
  async function deliver(scope: RunnableScope, key: string, id: string, schema: string): Promise<void> {
    const checked = await core.request("validate_payload", { bundle: scope.source, available_operations: scope.source.operations, schema, payload: {} });
    if (!checked.ok || checked.value.kind !== "validated") throw new Error(`invalid configured lifecycle payload: ${scope.id}/${key}`);
    const result = await mutations.decide({ run_id: scope.run_id, scope_id: scope.id as ScopeId, ingress_id: id,
      trigger: { id, key, payload: checked.value.value }, operator_version: null });
    if (!result.ok) throw new Error(`${result.error.operation}/${result.error.entity_id}: ${result.error.detail}`);
    if (result.value.kind === "Rejected" && result.value.detail !== "owner is terminal" && !result.value.detail.startsWith("apply_capacity/") ) throw new Error(result.value.detail);
  }
}
