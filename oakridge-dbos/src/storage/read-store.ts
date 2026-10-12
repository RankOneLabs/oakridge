import { sql, type Kysely } from "kysely";
import type { Action, Group, Unit, UnitStatus, Workflow } from "../core-client/core-types";
import type { DefinitionBundleId, RunId, UnitId } from "../domain/primitives";
import type { DefinitionDetail, DefinitionGraph, DefinitionPage, DefinitionSummary, PinnedDefinition } from "../projections/definition-view";
import type { OperatorEventDeliveryRow } from "../projections/operator-event";
import type { RunEventCursor } from "../projections/run-event";
import { selectRunInspect, type RunInspectView, type RunPage, type RunView } from "../projections/run-view";
import type { DB } from "./db-types";
import type { DatabaseTransaction } from "./database";
import { readScopedSnapshot } from "./snapshot-store";

type Reader = Kysely<DB> | DatabaseTransaction;

/**
 * Every projection read. Reads of more than one table run in one
 * repeatable-read transaction, so a projection never mixes two commits.
 */
async function consistent<Value>(db: Kysely<DB>, read: (trx: DatabaseTransaction) => Promise<Value>): Promise<Value> {
  return db.transaction().setIsolationLevel("repeatable read").setAccessMode("read only").execute(read);
}

// ----------------------------------------------------------------- runs -----

async function runView(trx: DatabaseTransaction, run_id: string): Promise<RunView | null> {
  const run = await trx.selectFrom("authority.run as run").innerJoin("authority.definition_bundle as bundle", "bundle.id", "run.definition_bundle_id")
    .select(["run.id", "run.definition_bundle_id", "bundle.digest", "run.version", "run.status", "run.created_at", "run.archived_at"])
    .where("run.id", "=", run_id).where("run.root_unit_id", "is not", null).executeTakeFirst();
  if (!run) return null;
  const units = await trx.selectFrom("authority.unit").select(["id", "unit_key", "stage", "status", "version"])
    .where("run_id", "=", run_id).orderBy("id").execute();
  return { run_id: run.id as RunId, definition_bundle_id: run.definition_bundle_id as DefinitionBundleId, definition_digest: run.digest,
    version: run.version, status: run.status, created_at: run.created_at, archived_at: run.archived_at,
    units: units.map((unit) => ({ unit_id: unit.id as UnitId, unit_key: unit.unit_key, stage: unit.stage, status: unit.status, version: unit.version })) };
}

/** A launched run; a run row whose launch was rejected has no root and is not a run to the operator. */
export async function readRunView(db: Kysely<DB>, run_id: string): Promise<RunView | null> {
  return consistent(db, (trx) => runView(trx, run_id));
}

export interface RunPageQuery { readonly after: { readonly created_at: string; readonly id: string } | null; readonly limit: number; readonly is_archived: boolean }
/** Newest first; one listing is either the archived runs or the active ones. */
export async function listRuns(db: Kysely<DB>, query: RunPageQuery): Promise<RunPage> {
  return consistent(db, async (trx) => {
    let page = trx.selectFrom("authority.run").select(["id", "created_at"]).where("root_unit_id", "is not", null)
      .where("archived_at", query.is_archived ? "is not" : "is", null);
    const after = query.after;
    if (after) page = page.where((eb) => eb(eb.refTuple("created_at", "id"), "<", eb.tuple(new Date(after.created_at), after.id)));
    const rows = await page.orderBy("created_at", "desc").orderBy("id", "desc").limit(query.limit + 1).execute();
    const selected = rows.slice(0, query.limit);
    const items: RunView[] = [];
    for (const row of selected) {
      const view = await runView(trx, row.id);
      if (view) items.push(view);
    }
    const last = selected.at(-1);
    return { items, next_cursor: rows.length > query.limit && last
      ? Buffer.from(JSON.stringify({ created_at: new Date(last.created_at).toISOString(), id: last.id })).toString("base64url") : null };
  });
}

/** The minimal inspect view (part 1 §10.4): units, statuses and what needs attention. */
export async function readRunInspect(db: Kysely<DB>, run_id: string): Promise<RunInspectView | null> {
  return consistent(db, async (trx) => {
    const snapshot = await readScopedSnapshot(trx, run_id, null);
    if (!snapshot) return null;
    const wanted = await trx.selectFrom("authority.wanted_log as wanted").innerJoin("authority.event as event", (join) =>
      join.onRef("event.run_id", "=", "wanted.run_id").onRef("event.id", "=", "wanted.event_id"))
      .distinctOn("wanted.unit_id").select(["wanted.unit_id", "wanted.actions"]).where("wanted.run_id", "=", run_id)
      .orderBy("wanted.unit_id").orderBy("event.created_at", "desc").orderBy("event.id", "desc").execute();
    return selectRunInspect(snapshot, wanted.map((row) => ({ unit_id: row.unit_id, actions: row.actions as readonly Action[] })));
  });
}

export interface RunStanding { readonly status: UnitStatus; readonly is_launched: boolean }
export async function readRunStanding(db: Reader, run_id: string): Promise<RunStanding | null> {
  const run = await db.selectFrom("authority.run").select(["status", "root_unit_id"]).where("id", "=", run_id).executeTakeFirst();
  return run ? { status: run.status, is_launched: run.root_unit_id !== null } : null;
}

/** Runs the executor must carry: launched and not terminal, or still owed an unsettled intent. One run when named. */
export async function listRunsNeedingWork(db: Reader, filter: { readonly run_id?: string } = {}): Promise<readonly RunId[]> {
  let runs = db.selectFrom("authority.run as run").select("run.id").where("run.root_unit_id", "is not", null);
  if (filter.run_id !== undefined) runs = runs.where("run.id", "=", filter.run_id);
  const rows = await runs
    .where((eb) => eb.or([
      eb(eb.ref("run.status", "->>").key("kind"), "not in", ["done", "cancelled"]),
      eb.exists(eb.selectFrom("authority.effect_intent as intent").select("intent.id").whereRef("intent.run_id", "=", "run.id")
        .where("intent.status", "in", ["pending", "acknowledged", "stop_requested"])),
    ])).orderBy("run.id").execute();
  return rows.map((row) => row.id as RunId);
}

// ---------------------------------------------------------- definitions -----

function groupNodes(group: Group, prefix = ""): DefinitionGraph["nodes"] {
  return Object.entries(group.units).flatMap(([key, unit]: [string, Unit]) => {
    const path = prefix ? `${prefix}/${key}` : key;
    const after = unit.after == null ? [] : typeof unit.after === "string" ? [unit.after] : unit.after;
    const node = { key: path, scope: unit.stage ?? key, depends_on: after.map((dependency) => prefix ? `${prefix}/${dependency}` : dependency) };
    return [node, ...(unit.group ? groupNodes(unit.group, path) : [])];
  });
}
/** The unit graph a workflow declares, for the catalog. */
export function selectDefinitionGraph(workflow: Workflow): DefinitionGraph {
  const nodes = groupNodes(workflow.run);
  return { nodes, edges: nodes.flatMap((node) => node.depends_on.map((from) => ({ from, to: node.key }))) };
}

/** One listing is either the archived definitions or the active ones. */
export async function listDefinitions(db: Reader, query: { readonly after: string | null; readonly limit: number; readonly is_archived: boolean }): Promise<DefinitionPage> {
  let page = db.selectFrom("authority.definition_bundle").select(["id as bundle_id", "digest", "source", "archived_at"])
    .where("archived_at", query.is_archived ? "is not" : "is", null);
  if (query.after !== null) page = page.where("id", "<", query.after);
  const rows = await page.orderBy("id", "desc").limit(query.limit + 1).execute();
  const items: DefinitionSummary[] = rows.slice(0, query.limit);
  const last = items.at(-1);
  return { items, next_cursor: rows.length > query.limit && last ? Buffer.from(last.bundle_id).toString("base64url") : null };
}

export async function readDefinition(db: Reader, bundle_id: string): Promise<DefinitionDetail | null> {
  const found = await db.selectFrom("authority.definition_bundle").select(["id as bundle_id", "digest", "source", "archived_at"])
    .where("id", "=", bundle_id).executeTakeFirst();
  return found ? { ...found, graph: selectDefinitionGraph(found.source) } : null;
}

export async function readPinnedDefinition(db: Reader, run_id: string): Promise<PinnedDefinition | null> {
  return await db.selectFrom("authority.definition_bundle as bundle").innerJoin("authority.run as run", "run.definition_bundle_id", "bundle.id")
    .select(["bundle.id as bundle_id", "bundle.digest", "bundle.source", "bundle.archived_at", "bundle.checked_program"])
    .where("run.id", "=", run_id).executeTakeFirst() ?? null;
}

// -------------------------------------------------------- operator stream ---

/**
 * Operator events after the cursor in writing-transaction order, limited to
 * transactions older than every one still open: those are all committed or
 * gone, so no later commit can land behind the cursor. `subscription_snapshot`
 * marks the rows a reconnecting subscriber had already seen.
 */
export async function readOperatorEventsAfter(db: Reader, input: { readonly after: RunEventCursor; readonly limit: number; readonly subscription_snapshot: string | null }): Promise<readonly OperatorEventDeliveryRow[]> {
  const { after, subscription_snapshot } = input;
  const rows = await db.selectFrom("authority.operator_event").select(["id", "event_key", "payload", "commit_txid",
    sql<boolean>`coalesce(pg_visible_in_snapshot(commit_txid::text::xid8, ${subscription_snapshot}::pg_snapshot), false)`.as("was_visible_at_subscription")])
    .where((eb) => eb(eb.refTuple("commit_txid", "id"), ">", eb.tuple(Number(after.commit_txid), after.id)))
    .where("commit_txid", "<", sql<number>`pg_snapshot_xmin(pg_current_snapshot())::text::bigint`)
    .orderBy("commit_txid").orderBy("id").limit(input.limit).execute();
  return rows.map((row) => ({ id: row.id, event_key: row.payload.kind, payload: row.payload, commit_txid: String(row.commit_txid),
    was_visible_at_subscription: row.was_visible_at_subscription }));
}

export interface EventStreamBoundary { readonly cursor: RunEventCursor; readonly snapshot: string }
/** One snapshot gives a new subscriber's safe starting cursor and a reconnect's replay classification. */
export async function readEventStreamBoundary(db: Reader): Promise<EventStreamBoundary> {
  const boundary = await sql<{ commit_txid: string; snapshot: string }>`WITH boundary AS MATERIALIZED (SELECT pg_current_snapshot() AS snapshot) SELECT pg_snapshot_xmin(snapshot)::text AS commit_txid, snapshot::text AS snapshot FROM boundary`.execute(db);
  const row = boundary.rows[0];
  if (!row) throw new Error("current snapshot unavailable");
  return { cursor: { commit_txid: row.commit_txid, id: "" }, snapshot: row.snapshot };
}
