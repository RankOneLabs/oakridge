import type { DefinitionBundle, Snapshot, Trigger, VersionedValue } from "../core-client/generated-contracts";
import type { CapacityPoolRecord, OutputSlotRecord, ResourceBindingRecord, ScopeExportRecord, ScopeId, ScopeInstanceRecord } from "./schema-records";
import type { SqlExecutor, TransactionalSqlExecutor } from "./sql-executor";

export const READ_RELATIONS = ["scope_instance", "scope_export", "child_collection", "execution_selection", "output_slot", "artifact_revision", "resource_binding", "capacity_pool", "capacity_reservation"] as const;
export type ReadRelation = typeof READ_RELATIONS[number];
export interface ReadWitness { readonly relation: ReadRelation; readonly id: string; readonly version: number }
export interface MembershipWitness { readonly relation: ReadRelation; readonly run_id: string; readonly signature: string }
export interface ReadSet { readonly rows: readonly ReadWitness[]; readonly membership: readonly MembershipWitness[] }
export interface AuthoritySnapshot { readonly snapshot: Snapshot; readonly read_set: ReadSet; readonly owner: ScopeInstanceRecord; readonly pools: readonly CapacityPoolRecord[] }
interface ImportedExport extends ScopeExportRecord { readonly child_key: string }
interface VersionRow { readonly id: string; readonly version: string | number }

const membershipSql: { readonly [Relation in ReadRelation]: string } = {
  scope_instance: "SELECT id, version FROM authority.scope_instance WHERE run_id = $1 ORDER BY id",
  scope_export: "SELECT e.id, e.version FROM authority.scope_export e JOIN authority.scope_instance s ON s.id=e.scope_id WHERE s.run_id=$1 ORDER BY e.id",
  child_collection: "SELECT e.id, e.version FROM authority.child_collection e JOIN authority.scope_instance s ON s.id=e.scope_id WHERE s.run_id=$1 ORDER BY e.id",
  execution_selection: "SELECT e.id, e.version FROM authority.execution_selection e JOIN authority.scope_instance s ON s.id=e.scope_id WHERE s.run_id=$1 ORDER BY e.id",
  output_slot: "SELECT e.id, e.version FROM authority.output_slot e JOIN authority.scope_instance s ON s.id=e.scope_id WHERE s.run_id=$1 ORDER BY e.id",
  artifact_revision: "SELECT e.id, e.version FROM authority.artifact_revision e JOIN authority.scope_instance s ON s.id=e.scope_id WHERE s.run_id=$1 ORDER BY e.id",
  resource_binding: "SELECT e.id, e.version FROM authority.resource_binding e JOIN authority.scope_instance s ON s.id=e.scope_id WHERE s.run_id=$1 ORDER BY e.id",
  capacity_pool: "SELECT id, version FROM authority.capacity_pool WHERE run_id=$1 ORDER BY id",
  capacity_reservation: "SELECT e.id, e.version FROM authority.capacity_reservation e JOIN authority.scope_instance s ON s.id=e.scope_id WHERE s.run_id=$1 ORDER BY e.id",
};
export async function readWitnesses(tx: SqlExecutor, run_id: string): Promise<ReadSet> {
  const rows: ReadWitness[] = [];
  const membership: MembershipWitness[] = [];
  for (const relation of READ_RELATIONS) {
    const found = await tx.query<VersionRow>(membershipSql[relation], [run_id]);
    const signature = found.map((row) => `${row.id}:${row.version}`).join("|");
    membership.push({ relation, run_id, signature });
    for (const row of found) rows.push({ relation, id: row.id, version: Number(row.version) });
  }
  return { rows, membership };
}

export async function readSnapshot(db: TransactionalSqlExecutor, scope_id: ScopeId, trigger: Trigger, random_seed = 0): Promise<AuthoritySnapshot | null> {
  return db.transaction(async (tx) => {
    const owners = await tx.query<ScopeInstanceRecord>("SELECT * FROM authority.scope_instance WHERE id=$1", [scope_id]);
    const owner = owners[0];
    if (!owner) return null;
    const read_set = await readWitnesses(tx, owner.run_id);
    const definitions = await tx.query<{ source: DefinitionBundle }>("SELECT b.source FROM authority.definition_bundle b JOIN authority.run r ON r.definition_bundle_id=b.id WHERE r.id=$1", [owner.run_id]);
    const scope = definitions[0]?.source.scopes.find((scope) => scope.key === owner.scope_key);
    if (!scope) return null;
    const exports = await tx.query<ImportedExport>("SELECT e.*, s.child_key FROM authority.scope_export e JOIN authority.scope_instance s ON s.id=e.scope_id WHERE s.parent_id=$1 ORDER BY e.id", [owner.id]);
    const slots = await tx.query<OutputSlotRecord>("SELECT * FROM authority.output_slot WHERE scope_id=$1 ORDER BY id", [owner.id]);
    const resources = await tx.query<ResourceBindingRecord>("SELECT * FROM authority.resource_binding WHERE scope_id=$1 ORDER BY id", [owner.id]);
    const pools = await tx.query<CapacityPoolRecord>("SELECT * FROM authority.capacity_pool WHERE run_id=$1", [owner.run_id]);
    const observations: VersionedValue[] = exports
      .filter((row) => scope.children.some((child) => child.key === row.child_key && child.imports.includes(row.export_key)))
      .map((row) => ({ identity: row.id, root: { kind: "child", key: row.child_key, export: row.export_key }, value: row.value, version: Number(row.version) }));
    for (const row of resources) if (row.observation && scope.resources.some((resource) => resource.key === row.resource_key)) observations.push({ identity: row.id, root: { kind: "resource", key: row.resource_key }, value: row.observation, version: Number(row.version) });
    for (const row of slots) if (row.current_revision_id && scope.outputs.some((output) => output.key === row.output_key)) {
      const revisions = await tx.query<{ body: VersionedValue["value"] }>("SELECT body FROM authority.artifact_revision WHERE id=$1", [row.current_revision_id]);
      if (revisions[0]) observations.push({ identity: row.id, root: { kind: "output", key: row.output_key }, value: revisions[0].body, version: Number(row.version) });
    }
    const snapshot: Snapshot = { owner: owner.id, scope: owner.scope_key, input: owner.input, state: owner.local_state,
      version: Number(owner.version), trigger, observations, random_seed, timestamp_ms: Date.now() };
    return { snapshot, read_set, owner: { ...owner, version: Number(owner.version) }, pools: pools.map((pool) => ({ ...pool, version: Number(pool.version) })) };
  }, "repeatable read");
}

export async function hasSameReadSet(tx: SqlExecutor, read_set: ReadSet): Promise<boolean> {
  const run_id = read_set.membership[0]?.run_id;
  if (!run_id || read_set.membership.length !== READ_RELATIONS.length) return false;
  const current = await readWitnesses(tx, run_id);
  return current.membership.every((item, index) => item.relation === read_set.membership[index]?.relation && item.signature === read_set.membership[index]?.signature);
}
