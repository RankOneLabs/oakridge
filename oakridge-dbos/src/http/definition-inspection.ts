import type { TransactionalSqlExecutor } from "../storage/sql-executor";
import type { DefinitionDetail, DefinitionGraph, DefinitionPage, DefinitionSummary, PinnedDefinition } from "../projections/definition-view";
import type { Group, Unit, Workflow } from "../core-client/core-types";

export type { DefinitionPage, DefinitionSummary, PinnedDefinition } from "../projections/definition-view";
function groupNodes(group: Group, prefix = ""): DefinitionGraph["nodes"] {
  return Object.entries(group.units).flatMap(([key, unit]: [string, Unit]) => {
    const path = prefix ? `${prefix}/${key}` : key;
    const after = unit.after == null ? [] : typeof unit.after === "string" ? [unit.after] : unit.after;
    const node = { key: path, scope: unit.stage ?? key, depends_on: after.map((dependency) => prefix ? `${prefix}/${dependency}` : dependency) };
    return [node, ...(unit.group ? groupNodes(unit.group, path) : [])];
  });
}
export function definitionGraph(bundle: Workflow): DefinitionGraph {
  const nodes = groupNodes(bundle.run);
  return { nodes, edges: nodes.flatMap((node) => node.depends_on.map((from) => ({ from, to: node.key }))) };
}
/** One listing is either the archived definitions or the active ones. */
export async function listDefinitions(db: TransactionalSqlExecutor, after: string | null, limit: number, is_archived = false): Promise<DefinitionPage> {
  const rows = await db.query<DefinitionSummary>(`SELECT id AS bundle_id,digest,source,archived_at FROM authority.definition_bundle
    WHERE ($1::text IS NULL OR id<$1) AND (archived_at IS NOT NULL)=$3 ORDER BY id DESC LIMIT $2`, [after, limit + 1, is_archived]);
  const items = rows.slice(0, limit);
  return { items, next_cursor: rows.length > limit && items.length ? Buffer.from(items[items.length - 1]!.bundle_id).toString("base64url") : null };
}
export async function readDefinition(db: TransactionalSqlExecutor, bundle_id: string): Promise<DefinitionDetail | null> {
  const rows = await db.query<DefinitionSummary>(
    "SELECT id AS bundle_id,digest,source,archived_at FROM authority.definition_bundle WHERE id=$1", [bundle_id]);
  const found = rows[0];
  return found ? { ...found, graph: definitionGraph(found.source) } : null;
}
export async function readPinnedDefinition(db: TransactionalSqlExecutor, run_id: string): Promise<PinnedDefinition | null> {
  const rows = await db.query<PinnedDefinition>(`SELECT b.id AS bundle_id,b.digest,b.source,b.archived_at,b.checked_program
    FROM authority.definition_bundle b JOIN authority.run r ON r.definition_bundle_id=b.id WHERE r.id=$1`, [run_id]);
  return rows[0] ?? null;
}
