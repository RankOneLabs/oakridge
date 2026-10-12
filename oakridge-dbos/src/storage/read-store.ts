import { sql, type Kysely } from "kysely";
import type { Action, Group, Unit, UnitStatus, Workflow } from "../core-client/core-types";
import type { DefinitionBundleId, RunId, UnitId } from "../domain/primitives";
import type { DefinitionDetail, DefinitionGraph, DefinitionPage, DefinitionSummary, PinnedDefinition } from "../projections/definition-view";
import type { OperatorEventDeliveryRow } from "../projections/operator-event";
import type { RunEventCursor } from "../projections/run-event";
import { selectRunInspect, type RunInspectView, type RunPage, type RunView } from "../projections/run-view";
import type { DB } from "./db-types";
import { anyOf, type DatabaseTransaction } from "./database";
import type { WantedActions } from "./json-column-types";
import type { ArtifactRevisionRecord, AttemptRecord, EffectIntentRecord, EventRecord, IngressReceiptRecord, ReviewDecisionRecord, UnitRecord } from "./schema-records";
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

// ---------------------------------------------------------------- units -----
// Store reads for the unit, attempt, artifact, history, diagnostics and inbox
// projections: authority rows as recorded, with no projection shape (R4).

export interface UnitLocation { readonly run_id: string; readonly unit_id: string }
/** What the executor has made of an attempt's intent, beside the attempt itself. */
export type IntentStanding = Pick<EffectIntentRecord, "id" | "action_id" | "seq" | "status" | "tries" | "next_try_at" | "last_error" | "updated_at">;
const INTENT_STANDING = ["id", "action_id", "seq", "status", "tries", "next_try_at", "last_error", "updated_at"] as const;

/** One unit and everything recorded against it, in the order it was recorded. */
export interface UnitRead {
  readonly unit: UnitRecord;
  readonly depends_on: readonly string[];
  readonly attempts: readonly AttemptRecord[];
  readonly revisions: readonly ArtifactRevisionRecord[];
  readonly decisions: readonly ReviewDecisionRecord[];
  readonly intents: readonly IntentStanding[];
}
export async function readUnit(db: Kysely<DB>, location: UnitLocation): Promise<UnitRead | null> {
  return consistent(db, async (trx) => {
    const unit = await trx.selectFrom("authority.unit").selectAll().where("run_id", "=", location.run_id).where("id", "=", location.unit_id).executeTakeFirst();
    if (!unit) return null;
    const [dependencies, attempts, revisions, decisions, intents] = await Promise.all([
      trx.selectFrom("authority.unit_dependency").select("depends_on_id").where("run_id", "=", location.run_id).where("unit_id", "=", location.unit_id)
        .orderBy("depends_on_id").execute(),
      trx.selectFrom("authority.attempt").selectAll().where("run_id", "=", location.run_id).where("unit_id", "=", location.unit_id)
        .orderBy("action_id").orderBy("seq").execute(),
      trx.selectFrom("authority.artifact_revision").selectAll().where("run_id", "=", location.run_id).where("unit_id", "=", location.unit_id)
        .orderBy("created_at").orderBy("id").execute(),
      trx.selectFrom("authority.review_decision").selectAll().where("run_id", "=", location.run_id).where("unit_id", "=", location.unit_id)
        .orderBy("id").execute(),
      trx.selectFrom("authority.effect_intent").select(INTENT_STANDING).where("run_id", "=", location.run_id).where("unit_id", "=", location.unit_id)
        .orderBy("action_id").orderBy("seq").execute(),
    ]);
    return { unit: unit as UnitRecord, depends_on: dependencies.map((row) => row.depends_on_id), attempts: attempts as AttemptRecord[],
      revisions: revisions as ArtifactRevisionRecord[], decisions: decisions as ReviewDecisionRecord[], intents: intents as IntentStanding[] };
  });
}

/** An attempt and the standing of the intent that carries its action (a periodic worker's attempts share one). */
export interface AttemptRead { readonly attempt: AttemptRecord; readonly intent: IntentStanding | null }
export async function listRunAttempts(db: Kysely<DB>, run_id: string): Promise<readonly AttemptRead[]> {
  return consistent(db, async (trx) => {
    const [attempts, intents] = await Promise.all([
      trx.selectFrom("authority.attempt").selectAll().where("run_id", "=", run_id).orderBy("unit_id").orderBy("action_id").orderBy("seq").execute(),
      trx.selectFrom("authority.effect_intent").select(INTENT_STANDING).where("run_id", "=", run_id).execute(),
    ]);
    const by_action = new Map(intents.map((intent) => [intent.action_id, intent as IntentStanding]));
    return attempts.map((attempt) => ({ attempt: attempt as AttemptRecord, intent: by_action.get(attempt.action_id) ?? null }));
  });
}

/** The running attempt a publication secret speaks for, and the kbbl session it was minted for. */
export interface SessionAttempt { readonly action_id: string; readonly seq: number; readonly unit_id: string; readonly kbbl_session_id: string }
/**
 * Resolve a publication secret's hash to its session's running attempt. The
 * secret is minted per kbbl session, so it names whichever attempt of that
 * session is running now; with none running, the secret speaks for nothing.
 */
export async function readSessionAttempt(db: Kysely<DB>, input: { readonly run_id: string; readonly secret_hash: string }): Promise<SessionAttempt | null> {
  return consistent(db, async (trx) => {
    const minted = await trx.selectFrom("authority.attempt").select("kbbl_session_id").where("run_id", "=", input.run_id)
      .where("publication_secret_hash", "=", input.secret_hash).where("kbbl_session_id", "is not", null).executeTakeFirst();
    if (!minted?.kbbl_session_id) return null;
    const running = await trx.selectFrom("authority.attempt").select(["action_id", "seq", "unit_id"]).where("run_id", "=", input.run_id)
      .where("kbbl_session_id", "=", minted.kbbl_session_id).where((eb) => eb(eb.ref("status", "->>").key("kind"), "=", "running"))
      .orderBy("seq", "desc").executeTakeFirst();
    return running ? { ...running, kbbl_session_id: minted.kbbl_session_id } : null;
  });
}

/** Every revision of one artifact, oldest first, and every decision made on any of them. */
export interface ArtifactHistory { readonly revisions: readonly ArtifactRevisionRecord[]; readonly decisions: readonly ReviewDecisionRecord[] }
export async function readArtifactHistory(db: Kysely<DB>, input: UnitLocation & { readonly artifact: string }): Promise<ArtifactHistory | null> {
  return consistent(db, async (trx) => {
    const unit = await trx.selectFrom("authority.unit").select("id").where("run_id", "=", input.run_id).where("id", "=", input.unit_id).executeTakeFirst();
    if (!unit) return null;
    const revisions = await trx.selectFrom("authority.artifact_revision").selectAll().where("run_id", "=", input.run_id)
      .where("unit_id", "=", input.unit_id).where("artifact", "=", input.artifact).orderBy("created_at").orderBy("id").execute();
    const revision_ids = revisions.map((revision) => revision.id);
    const decisions = revision_ids.length === 0 ? [] : await trx.selectFrom("authority.review_decision").selectAll()
      .where("run_id", "=", input.run_id).where("target_revision_id", "=", anyOf(revision_ids)).orderBy("id").execute();
    return { revisions: revisions as ArtifactRevisionRecord[], decisions: decisions as ReviewDecisionRecord[] };
  });
}

/** Events newest first: a run's, or one unit's. A launch or cancel names no unit, so it is in the run's history only. */
export interface HistoryQuery { readonly run_id: string; readonly unit_id: string | null; readonly after: HistoryCursor | null; readonly limit: number }
export interface HistoryCursor { readonly created_at: Date; readonly id: string }
export interface HistoryEntry { readonly event: EventRecord; readonly wanted: readonly { readonly unit_id: string; readonly actions: WantedActions }[] }
export interface HistoryPage { readonly items: readonly HistoryEntry[]; readonly next: HistoryCursor | null }
export async function readHistory(db: Kysely<DB>, query: HistoryQuery): Promise<HistoryPage> {
  return consistent(db, async (trx) => {
    let page = trx.selectFrom("authority.event").selectAll().where("run_id", "=", query.run_id);
    if (query.unit_id !== null) page = page.where("unit_id", "=", query.unit_id);
    const after = query.after;
    if (after) page = page.where((eb) => eb(eb.refTuple("created_at", "id"), "<", eb.tuple(after.created_at, after.id)));
    const rows = await page.orderBy("created_at", "desc").orderBy("id", "desc").limit(query.limit + 1).execute();
    const events = rows.slice(0, query.limit) as EventRecord[];
    const event_ids = events.map((event) => event.id);
    const wanted = event_ids.length === 0 ? [] : await trx.selectFrom("authority.wanted_log").select(["event_id", "unit_id", "actions"])
      .where("run_id", "=", query.run_id).where("event_id", "=", anyOf(event_ids)).orderBy("unit_id").execute();
    const last = events.at(-1);
    return { items: events.map((event) => ({ event, wanted: wanted.filter((row) => row.event_id === event.id)
        .filter((row) => query.unit_id === null || row.unit_id === query.unit_id).map((row) => ({ unit_id: row.unit_id, actions: row.actions })) })),
      next: rows.length > query.limit && last ? { created_at: last.created_at, id: last.id } : null };
  });
}

/** What went wrong around a unit: its intents' executor bookkeeping and the events step refused. */
export interface UnitDiagnostics { readonly intents: readonly IntentStanding[]; readonly rejected: readonly IngressReceiptRecord[] }
export async function readUnitDiagnostics(db: Kysely<DB>, location: UnitLocation): Promise<UnitDiagnostics | null> {
  return consistent(db, async (trx) => {
    const unit = await trx.selectFrom("authority.unit").select("id").where("run_id", "=", location.run_id).where("id", "=", location.unit_id).executeTakeFirst();
    if (!unit) return null;
    const [intents, rejected] = await Promise.all([
      trx.selectFrom("authority.effect_intent").select(INTENT_STANDING).where("run_id", "=", location.run_id).where("unit_id", "=", location.unit_id)
        .orderBy("action_id").orderBy("seq").execute(),
      trx.selectFrom("authority.ingress_receipt").selectAll().where("run_id", "=", location.run_id).where("unit_id", "=", location.unit_id)
        .where((eb) => eb(eb.ref("result", "->>").key("kind"), "=", "rejected")).orderBy("id").execute(),
    ]);
    return { intents: intents as IntentStanding[], rejected: rejected as IngressReceiptRecord[] };
  });
}

/**
 * Units that may be awaiting an operator decision: active stage units of live,
 * unarchived runs whose stage declares a review, each with the latest revision
 * of every artifact and the decisions on those revisions. Which of them
 * awaits a decision is derived by the inbox projection.
 */
export interface ReviewCandidate {
  readonly unit: UnitRecord;
  readonly workflow: Workflow;
  readonly latest: readonly ArtifactRevisionRecord[];
  readonly decisions: readonly ReviewDecisionRecord[];
}
export interface ReviewCandidateQuery { readonly run_id: string | null; readonly after: UnitLocation | null; readonly limit: number }
export interface ReviewCandidatePage { readonly items: readonly ReviewCandidate[]; readonly next: UnitLocation | null }
export async function listReviewCandidates(db: Kysely<DB>, query: ReviewCandidateQuery): Promise<ReviewCandidatePage> {
  return consistent(db, async (trx) => {
    let page = trx.selectFrom("authority.unit as unit").innerJoin("authority.run as run", "run.id", "unit.run_id")
      .innerJoin("authority.definition_bundle as bundle", "bundle.id", "run.definition_bundle_id")
      .selectAll("unit").select("bundle.source")
      .where("run.archived_at", "is", null).where((eb) => eb(eb.ref("run.status", "->>").key("kind"), "not in", ["done", "cancelled"]))
      .where((eb) => eb(eb.ref("unit.status", "->>").key("kind"), "=", "active")).where("unit.stage", "is not", null);
    if (query.run_id !== null) page = page.where("unit.run_id", "=", query.run_id);
    const after = query.after;
    if (after) page = page.where((eb) => eb(eb.refTuple("unit.run_id", "unit.id"), ">", eb.tuple(after.run_id, after.unit_id)));
    const rows = await page.orderBy("unit.run_id").orderBy("unit.id").limit(query.limit + 1).execute();
    const selected = rows.slice(0, query.limit);
    const reviewed = selected.filter((row) => row.stage !== null && Object.keys(row.source.stages[row.stage]?.reviews ?? {}).length > 0);
    const run_ids = [...new Set(reviewed.map((row) => row.run_id))];
    const latest = run_ids.length === 0 ? [] : await trx.selectFrom("authority.artifact_revision").selectAll()
      .distinctOn(["run_id", "unit_id", "artifact"]).where("run_id", "=", anyOf(run_ids)).where("unit_id", "=", anyOf(reviewed.map((row) => row.id)))
      .orderBy("run_id").orderBy("unit_id").orderBy("artifact").orderBy("created_at", "desc").orderBy("id", "desc").execute();
    const latest_ids = latest.map((revision) => revision.id);
    const decisions = latest_ids.length === 0 ? [] : await trx.selectFrom("authority.review_decision").selectAll()
      .where("target_revision_id", "=", anyOf(latest_ids)).orderBy("id").execute();
    const last = selected.at(-1);
    return {
      items: reviewed.map(({ source, ...unit }) => ({ unit: unit as UnitRecord, workflow: source,
        latest: latest.filter((revision) => revision.run_id === unit.run_id && revision.unit_id === unit.id) as ArtifactRevisionRecord[],
        decisions: decisions.filter((decision) => decision.run_id === unit.run_id && decision.unit_id === unit.id) as ReviewDecisionRecord[] })),
      next: rows.length > query.limit && last ? { run_id: last.run_id, unit_id: last.id } : null,
    };
  });
}

// ---------------------------------------------------------- definitions -----

function groupNodes(group: Group, prefix = ""): DefinitionGraph["nodes"] {
  return Object.entries(group.units).flatMap(([key, unit]: [string, Unit]) => {
    const path = prefix ? `${prefix}/${key}` : key;
    // A string `after` is an expression evaluated per collection member, not a unit key: it has no static edge.
    const after = unit.after == null || typeof unit.after === "string" ? [] : unit.after;
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
    .where((eb) => eb(eb.refTuple("commit_txid", "id"), ">", eb.tuple(eb.cast<number>(eb.val(after.commit_txid), "bigint"), after.id)))
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
