import { observationRootKey, selectObservationRoots } from "../core-client/observation-roots";
import type { CheckedValue, CompiledBundle, DefinitionBundle, ReferenceRoot, Snapshot, Trigger, VersionedValue } from "../core-client/generated-contracts";
import type { CapacityPoolRecord, OutputSlotRecord, RevisionId, ResourceBindingRecord, ScopeExportRecord, ScopeId, ScopeInstanceRecord } from "./schema-records";
import type { SqlExecutor, TransactionalSqlExecutor } from "./sql-executor";

export const READ_RELATIONS = ["scope_instance", "scope_export", "child_collection", "execution_selection", "execution", "output_slot", "artifact_revision", "resource_binding", "capacity_pool", "capacity_reservation"] as const;
export type ReadRelation = typeof READ_RELATIONS[number];
/** Capacity rows use separate lock handling when the decision has no capacity change. */
export const CAPACITY_READ_RELATIONS: readonly ReadRelation[] = ["capacity_pool", "capacity_reservation"];
export interface ReadWitness { readonly relation: ReadRelation; readonly id: string; readonly version: number }
export interface MembershipWitness { readonly relation: ReadRelation; readonly run_id: string; readonly signature: string }
export interface ReadSet { readonly scope_id: ScopeId; readonly pool_keys: readonly string[]; readonly rows: readonly ReadWitness[]; readonly membership: readonly MembershipWitness[] }
export interface AuthoritySnapshot { readonly snapshot: Snapshot; readonly reads: readonly ReferenceRoot[]; readonly read_set: ReadSet; readonly owner: ScopeInstanceRecord; readonly pools: readonly CapacityPoolRecord[]; readonly current_outputs: readonly CurrentOutput[] }
export interface CurrentOutput extends OutputSlotRecord { readonly current_revision_id: RevisionId; readonly body: VersionedValue["value"] }
interface ImportedExport extends ScopeExportRecord { readonly child_key: string; readonly child_id: string; readonly collection_key: string | null }
interface VersionRow { readonly id: string; readonly version: string | number }

const membershipSql: { readonly [Relation in ReadRelation]: string } = {
  scope_instance: "SELECT id,version FROM authority.scope_instance WHERE id=ANY($1::text[]) ORDER BY id",
  scope_export: "SELECT id,version FROM authority.scope_export WHERE scope_id=ANY($1::text[]) ORDER BY id",
  child_collection: "SELECT id,version FROM authority.child_collection WHERE scope_id=ANY($1::text[]) ORDER BY id",
  execution_selection: "SELECT id,version FROM authority.execution_selection WHERE scope_id=ANY($1::text[]) ORDER BY id",
  execution: "SELECT id,version FROM authority.execution WHERE scope_id=ANY($1::text[]) ORDER BY id",
  output_slot: "SELECT id,version FROM authority.output_slot WHERE scope_id=ANY($1::text[]) ORDER BY id",
  artifact_revision: "SELECT id,version FROM authority.artifact_revision WHERE scope_id=ANY($1::text[]) ORDER BY id",
  resource_binding: "SELECT id,version FROM authority.resource_binding WHERE scope_id=ANY($1::text[]) ORDER BY id",
  capacity_pool: "SELECT id,version FROM authority.capacity_pool WHERE run_id=$1 AND pool_key=ANY($2::text[]) ORDER BY id",
  capacity_reservation: "SELECT id,version FROM authority.capacity_reservation WHERE scope_id=ANY($1::text[]) ORDER BY id",
};
export async function readWitnesses(tx: SqlExecutor, run_id: string, scope_id: ScopeId, pool_keys: readonly string[]): Promise<ReadSet> {
  const descendants = await tx.query<{ id: string }>(`WITH RECURSIVE subtree AS (
    SELECT id FROM authority.scope_instance WHERE id=$1 AND run_id=$2
    UNION ALL SELECT child.id FROM authority.scope_instance child JOIN subtree parent ON child.parent_id=parent.id
  ) SELECT id FROM subtree ORDER BY id`, [scope_id, run_id]);
  const scope_ids = descendants.map((row) => row.id);
  const rows: ReadWitness[] = [];
  const membership: MembershipWitness[] = [];
  for (const relation of READ_RELATIONS) {
    const found = await tx.query<VersionRow>(membershipSql[relation], relation === "capacity_pool" ? [run_id, pool_keys] : [scope_ids]);
    const signature = JSON.stringify(found.map((row) => [row.id, String(row.version)]));
    membership.push({ relation, run_id, signature });
    for (const row of found) rows.push({ relation, id: row.id, version: Number(row.version) });
  }
  return { scope_id, pool_keys, rows, membership };
}

interface ScopeObservations { readonly observations: VersionedValue[]; readonly current_outputs: readonly CurrentOutput[] }
interface ScopeObservationInput { readonly owner: ScopeInstanceRecord; readonly scope: DefinitionBundle["scopes"][number]; readonly bundle: DefinitionBundle; readonly reads: readonly ReferenceRoot[] }

/** Use the same observation identities for decisions and operator projections. */
export async function readScopeObservations(tx: SqlExecutor, { owner, scope, bundle, reads }: ScopeObservationInput): Promise<ScopeObservations> {
  const exports = await tx.query<ImportedExport>("SELECT e.*, s.child_key,s.id AS child_id,s.collection_key FROM authority.scope_export e JOIN authority.scope_instance s ON s.id=e.scope_id WHERE s.parent_id=$1 ORDER BY e.id", [owner.id]);
  const slots = await tx.query<CurrentOutput>("SELECT s.*, r.body FROM authority.output_slot s JOIN authority.artifact_revision r ON r.id=s.current_revision_id WHERE s.scope_id=$1 ORDER BY s.id", [owner.id]);
  const resources = await tx.query<ResourceBindingRecord>("SELECT * FROM authority.resource_binding WHERE scope_id=$1 ORDER BY id", [owner.id]);
  const results = await tx.query<{ id: string; worker_key: string; result: VersionedValue["value"]; version: string | number }>(
    "SELECT e.* FROM authority.execution e JOIN authority.execution_selection s ON s.execution_id=e.id WHERE e.scope_id=$1 AND e.result IS NOT NULL ORDER BY e.id", [owner.id]);
  const observations: VersionedValue[] = exports
    .filter((row) => row.collection_key == null && scope.children.some((child) => child.key === row.child_key && !child.collection && child.imports.includes(row.export_key)))
    .map((row) => ({ identity: row.id, root: { kind: "child", key: row.child_key, export: row.export_key }, value: row.value, version: Number(row.version) }));
  for (const row of resources) if (row.observation && scope.resources.some((resource) => resource.key === row.resource_key)) observations.push({ identity: row.id, root: { kind: "resource", key: row.resource_key }, value: row.observation, version: Number(row.version) });
  for (const row of slots) if (scope.outputs.some((output) => output.key === row.output_key && output.collection_key === null)) observations.push({ identity: row.id, root: { kind: "output", key: row.output_key }, value: row.body, version: Number(row.version) });
  for (const row of results) if (scope.workers.some((worker) => worker.key === row.worker_key)) observations.push({ identity: row.id, root: { kind: "result", worker: row.worker_key }, value: row.result, version: Number(row.version) });
  const collections = await tx.query<import("./schema-records").ChildCollectionRecord>("SELECT * FROM authority.child_collection WHERE scope_id=$1 ORDER BY id", [owner.id]);
  const children = await tx.query<ScopeInstanceRecord>("SELECT * FROM authority.scope_instance WHERE parent_id=$1 ORDER BY child_key,id", [owner.id]);
  for (const root of selectObservationRoots({ reads: [...reads] })) {
    let value: CheckedValue | null = null;
    let identity = JSON.stringify(root);
    let version = Number(owner.version);
    if (root.kind === "output_revision" || root.kind === "optional_output_revision") {
      const slot = slots.find((slot) => slot.output_key === root.key && slot.collection_key === "");
      const target_schema = bundle.schemas.find((schema) => schema.key === root.schema)?.shape;
      const revision_schema = root.kind === "output_revision" ? root.schema : target_schema?.kind === "optional" ? target_schema.item : null;
      if (!revision_schema) throw new Error("revision observation schema missing");
      const revision: CheckedValue | null = slot?.current_revision_id ? { schema: revision_schema, data: { kind: "reference", brand: "artifact_revision", id: slot.current_revision_id } } : null;
      value = root.kind === "optional_output_revision" ? { schema: root.schema, data: { kind: "optional", value: revision } } : revision;
      identity = `${slot?.id ?? owner.id}:${observationRootKey(root)}`;
      version = Number(slot?.version ?? owner.version);
    }
    if (root.kind === "output_revisions") {
      const shape = bundle.schemas.find((schema) => schema.key === root.schema)?.shape;
      if (shape?.kind !== "list") throw new Error("revision collection schema missing");
      value = { schema: root.schema, data: { kind: "list", items: slots.filter((slot) => slot.output_key === root.key)
        .sort((a,b) => a.collection_key.localeCompare(b.collection_key)).map((slot) => ({ schema: shape.item, data: { kind: "reference", brand: "artifact_revision", id: slot.current_revision_id } })) } };
    }
    if (root.kind === "output_collection") {
      const members = slots.filter((slot) => slot.output_key === root.key).sort((a,b) => a.collection_key.localeCompare(b.collection_key));
      value = { schema: root.schema, data: { kind: "list", items: members.map((member) => member.body) } };
    }
    if (root.kind === "children" || root.kind === "children_outcomes" || root.kind === "children_complete") {
      const collection = collections.find((collection) => collection.collection_key === root.key);
      const member_ids = collection?.members.map((member) => typeof member === "string" ? member : member.id);
      const members = children.filter((child) => member_ids ? member_ids.includes(child.id) : child.collection_key == null && child.child_key === root.key);
      if (root.kind === "children_complete") {
        value = { schema: root.schema, data: { kind: "boolean", value: (collection !== undefined || members.length > 0) && members.every((member) => member.is_terminal) } };
      } else {
        const items = root.kind === "children_outcomes" ? members.flatMap((child) => child.outcome ? [child.outcome] : [])
          : members.flatMap((child) => exports.filter((item) => item.child_id === child.id && item.export_key === root.export).map((item) => item.value));
        value = { schema: root.schema, data: { kind: "list", items } };
      }
      identity = `${collection?.id ?? owner.id}:${observationRootKey(root)}`;
      version = Number(collection?.version ?? owner.version);
    }
    if (value) observations.push({ identity, root, value, version });
  }
  const allowed = new Set(reads.map(observationRootKey));
  return { observations: observations.filter((observation) => allowed.has(observationRootKey(observation.root))), current_outputs: slots };
}

export async function readSnapshot(db: TransactionalSqlExecutor, scope_id: ScopeId, trigger: Trigger, random_seed = 0,
  pinned_definition?: { readonly source: DefinitionBundle; readonly checked_program: CompiledBundle }): Promise<AuthoritySnapshot | null> {
  return db.transaction(async (tx) => {
    const owners = await tx.query<ScopeInstanceRecord>("SELECT * FROM authority.scope_instance WHERE id=$1", [scope_id]);
    const owner = owners[0];
    if (!owner) return null;
    const definition = pinned_definition ?? (await tx.query<{ source: DefinitionBundle; checked_program: CompiledBundle }>("SELECT b.source,b.checked_program FROM authority.definition_bundle b JOIN authority.run r ON r.definition_bundle_id=b.id WHERE r.id=$1", [owner.run_id]))[0];
    const bundle = definition?.source;
    const scope = bundle?.scopes.find((scope) => scope.key === owner.scope_key);
    const reads = definition?.checked_program?.scopes?.find((scope) => scope.key === owner.scope_key)?.reads;
    if (!scope || !bundle || !reads) return null;
    const read_set = await readWitnesses(tx, owner.run_id, scope_id, (scope.pools ?? []).map((pool) => pool.key));
    const { observations, current_outputs } = await readScopeObservations(tx, { owner, scope, bundle, reads });
    const pools = await tx.query<CapacityPoolRecord>("SELECT * FROM authority.capacity_pool WHERE run_id=$1", [owner.run_id]);
    const snapshot: Snapshot = { owner: owner.id, scope: owner.scope_key, input: owner.input, state: owner.local_state,
      version: Number(owner.version), trigger, observations, random_seed, timestamp_ms: Date.now() };
    return { snapshot, reads, read_set, current_outputs, owner: { ...owner, version: Number(owner.version) }, pools: pools.map((pool) => ({ ...pool, version: Number(pool.version) })) };
  }, "repeatable read");
}

export async function hasSameReadSet(tx: SqlExecutor, read_set: ReadSet): Promise<boolean> {
  const run_id = read_set.membership[0]?.run_id;
  const expected_relations = READ_RELATIONS;
  if (!run_id || read_set.membership.length !== expected_relations.length
    || expected_relations.some((relation) => !read_set.membership.some((item) => item.relation === relation))) return false;
  const current = await readWitnesses(tx, run_id, read_set.scope_id, read_set.pool_keys);
  return current.membership.every((item, index) => item.relation === read_set.membership[index]?.relation && item.signature === read_set.membership[index]?.signature);
}
