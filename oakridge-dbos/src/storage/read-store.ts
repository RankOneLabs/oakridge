import { sql, type Kysely } from "kysely";
import type { UnitStatus, Workflow } from "../core-client/core-types";
import type { RunId, UnitId } from "../domain/primitives";
import type { CommitFaultNotice, OperatorEventDeliveryRow } from "../projections/operator-event";
import type { RunEventCursor } from "../projections/run-event";
import type { SessionHold } from "../projections/session-hold";
import type { DB } from "./db-types";
import { anyOf, type DatabaseTransaction } from "./database";
import type { CompiledWorkflow, StallRecord, WantedActions } from "./json-column-types";
import type { ArtifactRevisionRecord, AttemptRecord, EffectIntentRecord, EventRecord, IngressReceiptRecord, ReviewDecisionRecord, RunRecord,
  UnitDependencyRecord, UnitRecord } from "./schema-records";

type Reader = Kysely<DB> | DatabaseTransaction;

/**
 * Every projection read. Reads of more than one table run in one
 * repeatable-read transaction, so a projection never mixes two commits.
 * The store returns authority rows as recorded; projections/ shapes them.
 */
async function consistent<Value>(db: Kysely<DB>, read: (trx: DatabaseTransaction) => Promise<Value>): Promise<Value> {
  return db.transaction().setIsolationLevel("repeatable read").setAccessMode("read only").execute(read);
}

// ----------------------------------------------------------------- runs -----

/** The definition a run is pinned to, as the projections read it. */
export interface PinnedSource { readonly digest: string; readonly version: number; readonly workflow: Workflow }
/** An operator retry, in the order it was requested. */
/** An operator's retry request; `retry_id` is its ingress id, the identity an attempt's retry cause names. */
export interface RetryRequest { readonly unit_id: string; readonly worker: string; readonly retry_id: string }
/** The actions the latest event that stepped a unit left wanted for it. */
export interface UnitWanted { readonly unit_id: string; readonly actions: WantedActions }
/** An event step refused because the run could not advance past it; `unit_id` is the unit the event addressed. */
export interface StallRefusal { readonly unit_id: string | null; readonly ingress_id: string; readonly reason: string; readonly stall: StallRecord }
/** The latest event committed on one unit of a run; `unit_id` null for the events that address the run (launch, cancel). */
export interface LatestUnitEvent { readonly unit_id: string | null; readonly event_id: string; readonly created_at: Date }
/**
 * One launched run and everything recorded against it, each in the order
 * commit wrote it: the source of every run, unit, inbox and inspect projection.
 */
export interface RunRead {
  readonly run: RunRecord;
  readonly definition: PinnedSource;
  readonly units: readonly UnitRecord[];
  readonly dependencies: readonly UnitDependencyRecord[];
  readonly attempts: readonly AttemptRecord[];
  readonly revisions: readonly ArtifactRevisionRecord[];
  readonly decisions: readonly ReviewDecisionRecord[];
  readonly retries: readonly RetryRequest[];
  readonly wanted: readonly UnitWanted[];
  /** Refusals that recorded where the run stopped advancing, in the order they were refused. */
  readonly stalls: readonly StallRefusal[];
  /** Faulted commits recorded against the run, in the order they faulted. */
  readonly faults: readonly CommitFaultNotice[];
  readonly latest_events: readonly LatestUnitEvent[];
}

/**
 * Launched runs, in the order asked; a run row whose launch was rejected has
 * no root and is not a run to the operator. One query per table for every
 * run asked, so a page of runs costs what one run does.
 */
async function runReads(trx: DatabaseTransaction, run_ids: readonly string[]): Promise<readonly RunRead[]> {
  if (run_ids.length === 0) return [];
  const ids = anyOf(run_ids);
  // Action ids are hashes: attempts, revisions and decisions read in the order commit wrote them.
  const [runs, units, dependencies, attempts, revisions, decisions, retries, wanted, stalls, faults, latest_events] = await Promise.all([
    trx.selectFrom("authority.run as run").innerJoin("authority.definition_bundle as bundle", "bundle.id", "run.definition_bundle_id")
      .selectAll("run").select(["bundle.digest", "bundle.version as bundle_version", "bundle.source"])
      .where("run.id", "=", ids).where("run.root_unit_id", "is not", null).execute(),
    trx.selectFrom("authority.unit").selectAll().where("run_id", "=", ids).orderBy("id").execute(),
    trx.selectFrom("authority.unit_dependency").selectAll().where("run_id", "=", ids).orderBy("unit_id").orderBy("depends_on_id").execute(),
    trx.selectFrom("authority.attempt").selectAll().where("run_id", "=", ids).orderBy("created_at").orderBy("action_id").orderBy("seq").execute(),
    trx.selectFrom("authority.artifact_revision").selectAll().where("run_id", "=", ids).orderBy("created_at").orderBy("id").execute(),
    trx.selectFrom("authority.review_decision").selectAll().where("run_id", "=", ids).orderBy("created_at").orderBy("id").execute(),
    trx.selectFrom("authority.event").select(["id", "run_id", "unit_id", "ingress_id", "payload"]).where("run_id", "=", ids)
      .where((eb) => eb(eb.ref("payload", "->>").key("kind"), "=", "retry_requested")).orderBy("created_at").orderBy("id").execute(),
    trx.selectFrom("authority.wanted_log as wanted").innerJoin("authority.event as event", (join) =>
      join.onRef("event.run_id", "=", "wanted.run_id").onRef("event.id", "=", "wanted.event_id"))
      .distinctOn(["wanted.run_id", "wanted.unit_id"]).select(["wanted.run_id", "wanted.unit_id", "wanted.actions"]).where("wanted.run_id", "=", ids)
      .orderBy("wanted.run_id").orderBy("wanted.unit_id").orderBy("event.created_at", "desc").orderBy("event.id", "desc").execute(),
    trx.selectFrom("authority.ingress_receipt").select(["run_id", "unit_id", "ingress_id", "result"]).where("run_id", "=", ids)
      .where((eb) => eb(eb.ref("result", "->>").key("kind"), "=", "rejected"))
      .where((eb) => eb(eb.ref("result", "->").key("stall"), "is not", null)).execute(),
    trx.selectFrom("authority.operator_event").select(["run_id", "payload"]).where("run_id", "=", ids).where("event_key", "=", "commit_fault")
      .orderBy("created_at").orderBy("id").execute(),
    trx.selectFrom("authority.event").distinctOn(["run_id", "unit_id"]).select(["run_id", "unit_id", "id", "created_at"]).where("run_id", "=", ids)
      .orderBy("run_id").orderBy("unit_id").orderBy("created_at", "desc").orderBy("id", "desc").execute(),
  ]);
  const of = <Row extends { readonly run_id: string }>(rows: readonly Row[], run_id: string): Row[] => rows.filter((row) => row.run_id === run_id);
  return run_ids.flatMap((run_id) => {
    const found = runs.find((run) => run.id === run_id);
    if (!found) return [];
    const { digest, bundle_version, source, ...run } = found;
    return [{ run: run as RunRecord, definition: { digest, version: bundle_version, workflow: source },
      units: of(units, run_id) as UnitRecord[], dependencies: of(dependencies, run_id) as UnitDependencyRecord[],
      attempts: of(attempts, run_id) as AttemptRecord[], revisions: of(revisions, run_id) as ArtifactRevisionRecord[],
      decisions: of(decisions, run_id) as ReviewDecisionRecord[],
      retries: of(retries, run_id).flatMap((retry) => retry.payload.kind === "retry_requested" && retry.unit_id !== null && retry.ingress_id !== null
        ? [{ unit_id: retry.unit_id, worker: retry.payload.worker, retry_id: retry.ingress_id }] : []),
      wanted: of(wanted, run_id).map(({ unit_id, actions }) => ({ unit_id, actions })),
      stalls: of(stalls, run_id).flatMap(({ unit_id, ingress_id, result }) => result.kind === "rejected" && result.stall
        ? [{ unit_id, ingress_id, reason: result.reason, stall: result.stall }] : [])
        .sort((left, right) => left.stall.refused_at.localeCompare(right.stall.refused_at)),
      faults: faults.flatMap((row) => row.run_id === run_id && row.payload.kind === "commit_fault" ? [row.payload.data] : []),
      latest_events: of(latest_events, run_id).map(({ unit_id, id, created_at }) => ({ unit_id, event_id: id, created_at })) }];
  });
}
const runRead = async (trx: DatabaseTransaction, run_id: string): Promise<RunRead | null> => (await runReads(trx, [run_id]))[0] ?? null;

export async function readRun(db: Kysely<DB>, run_id: string): Promise<RunRead | null> {
  return consistent(db, (trx) => runRead(trx, run_id));
}

export interface RunPageQuery { readonly after: { readonly created_at: string; readonly id: string } | null; readonly limit: number; readonly is_archived: boolean }
export interface RunReadPage { readonly items: readonly RunRead[]; readonly next: { readonly created_at: Date; readonly id: string } | null }
/** Newest first; one listing is either the archived runs or the active ones. */
export async function listRuns(db: Kysely<DB>, query: RunPageQuery): Promise<RunReadPage> {
  return consistent(db, async (trx) => {
    let page = trx.selectFrom("authority.run").select(["id", "created_at"]).where("root_unit_id", "is not", null)
      .where("archived_at", query.is_archived ? "is not" : "is", null);
    const after = query.after;
    if (after) page = page.where((eb) => eb(eb.refTuple("created_at", "id"), "<", eb.tuple(new Date(after.created_at), after.id)));
    const rows = await page.orderBy("created_at", "desc").orderBy("id", "desc").limit(query.limit + 1).execute();
    const selected = rows.slice(0, query.limit);
    const items = await runReads(trx, selected.map((row) => row.id));
    const last = selected.at(-1);
    return { items, next: rows.length > query.limit && last ? { created_at: last.created_at, id: last.id } : null };
  });
}

/** A run and its most recent events, newest first: the minimal inspect view's source (part 1 §10.4). */
export interface RunInspectRead { readonly run: RunRead; readonly events: readonly EventRecord[] }
const INSPECT_EVENTS = 100;
export async function readRunInspect(db: Kysely<DB>, run_id: string): Promise<RunInspectRead | null> {
  return consistent(db, async (trx) => {
    const run = await runRead(trx, run_id);
    if (!run) return null;
    const events = await trx.selectFrom("authority.event").selectAll().where("run_id", "=", run_id)
      .orderBy("created_at", "desc").orderBy("id", "desc").limit(INSPECT_EVENTS).execute();
    return { run, events: events as EventRecord[] };
  });
}

export interface LiveRunQuery { readonly after: string | null; readonly limit: number }
export interface LiveRunPage { readonly items: readonly RunRead[]; readonly next: string | null }
/** Launched runs that are neither finished nor archived, by id: what the inbox derives its items from. */
export async function listLiveRuns(db: Kysely<DB>, query: LiveRunQuery): Promise<LiveRunPage> {
  return consistent(db, async (trx) => {
    let page = trx.selectFrom("authority.run").select("id").where("root_unit_id", "is not", null).where("archived_at", "is", null)
      .where((eb) => eb(eb.ref("status", "->>").key("kind"), "not in", ["done", "cancelled"]));
    if (query.after !== null) page = page.where("id", ">", query.after);
    const rows = await page.orderBy("id").limit(query.limit + 1).execute();
    const selected = rows.slice(0, query.limit);
    const items = await runReads(trx, selected.map((row) => row.id));
    return { items, next: rows.length > query.limit ? selected.at(-1)?.id ?? null : null };
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

export interface UnitLocation { readonly run_id: string; readonly unit_id: string }
/** What the executor has made of an attempt's intent, beside the attempt itself. */
export type IntentStanding = Pick<EffectIntentRecord, "id" | "action_id" | "seq" | "status" | "tries" | "next_try_at" | "last_error" | "updated_at">;
const INTENT_STANDING = ["id", "action_id", "seq", "status", "tries", "next_try_at", "last_error", "updated_at"] as const;

/** An agent attempt whose task is about to be rendered, and what it reads beside its instruction. */
export interface SessionHistoryQuery {
  readonly run_id: string;
  readonly unit_id: string;
  readonly worker: string;
  readonly attempt: { readonly action_id: string; readonly seq: number };
  /** The artifacts the worker creates. */
  readonly artifacts: readonly string[];
}
/**
 * The state an agent's task is rendered from beside its instruction, as it
 * stood when commit opened the attempt: only rows written by then are read,
 * so a task rendered again after a crash is the same text.
 */
export interface SessionHistory {
  /** The worker's attempts on this unit opened before this one, oldest first. */
  readonly earlier_attempts: readonly AttemptRecord[];
  /** The latest revision of each created artifact, as of the attempt opening. */
  readonly latest: readonly ArtifactRevisionRecord[];
}
export async function readSessionHistory(db: Kysely<DB>, query: SessionHistoryQuery): Promise<SessionHistory | null> {
  return consistent(db, async (trx) => {
    const current = await trx.selectFrom("authority.attempt").select("created_at").where("run_id", "=", query.run_id)
      .where("action_id", "=", query.attempt.action_id).where("seq", "=", query.attempt.seq).executeTakeFirst();
    if (!current) return null;
    const opened_at = current.created_at;
    const [earlier_attempts, latest] = await Promise.all([
      trx.selectFrom("authority.attempt").selectAll().where("run_id", "=", query.run_id).where("unit_id", "=", query.unit_id)
        .where("worker", "=", query.worker).where("created_at", "<=", opened_at)
        .where((eb) => eb.not(eb.and([eb("action_id", "=", query.attempt.action_id), eb("seq", "=", query.attempt.seq)])))
        .orderBy("created_at").orderBy("action_id").orderBy("seq").execute(),
      query.artifacts.length === 0 ? [] : trx.selectFrom("authority.artifact_revision").selectAll().distinctOn("artifact")
        .where("run_id", "=", query.run_id).where("unit_id", "=", query.unit_id).where("artifact", "=", anyOf(query.artifacts))
        .where("created_at", "<=", opened_at).orderBy("artifact").orderBy("created_at", "desc").orderBy("id", "desc").execute(),
    ]);
    return { earlier_attempts: earlier_attempts as AttemptRecord[], latest: latest as ArtifactRevisionRecord[] };
  });
}

/** The latest revision of one artifact, which a code worker's output names as its predecessor; null before the first. */
export async function readLatestRevisionId(db: Reader, input: UnitLocation & { readonly artifact: string }): Promise<string | null> {
  const latest = await db.selectFrom("authority.artifact_revision").select("id").where("run_id", "=", input.run_id)
    .where("unit_id", "=", input.unit_id).where("artifact", "=", input.artifact)
    .orderBy("created_at", "desc").orderBy("id", "desc").executeTakeFirst();
  return latest?.id ?? null;
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

/** The running attempt using a kbbl session, in any run, or null when none is. */
export async function readSessionHold(db: Kysely<DB>, session_id: string): Promise<SessionHold | null> {
  const running = await db.selectFrom("authority.attempt").select(["run_id", "unit_id", "worker", "action_id"])
    .where("kbbl_session_id", "=", session_id).where((eb) => eb(eb.ref("status", "->>").key("kind"), "=", "running"))
    .orderBy("created_at", "desc").executeTakeFirst();
  return running ? { session_id, run_id: running.run_id as RunId, unit_id: running.unit_id as UnitId, worker: running.worker, action_id: running.action_id } : null;
}

/** Events newest first: a run's, or one unit's. A launch or cancel names no unit, so it is in the run's history only. */
export interface HistoryQuery { readonly run_id: string; readonly unit_id: string | null; readonly after: HistoryCursor | null; readonly limit: number }
export interface HistoryCursor { readonly created_at: Date; readonly id: string }
export interface HistoryEntry { readonly event: EventRecord; readonly wanted: readonly { readonly unit_id: string; readonly actions: WantedActions }[] }
export interface HistoryPage { readonly items: readonly HistoryEntry[]; readonly next: HistoryCursor | null }
/** Null when the named unit is not part of the run. */
export async function readHistory(db: Kysely<DB>, query: HistoryQuery): Promise<HistoryPage | null> {
  return consistent(db, async (trx) => {
    if (query.unit_id !== null) {
      const unit = await trx.selectFrom("authority.unit").select("id").where("run_id", "=", query.run_id).where("id", "=", query.unit_id).executeTakeFirst();
      if (!unit) return null;
    }
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

/** What went wrong around a unit: the unit, its attempts, its intents' executor bookkeeping and the events step refused. */
export interface UnitDiagnosticsRead {
  readonly unit: UnitRecord;
  readonly attempts: readonly AttemptRecord[];
  readonly intents: readonly IntentStanding[];
  readonly rejected: readonly IngressReceiptRecord[];
}
export async function readUnitDiagnostics(db: Kysely<DB>, location: UnitLocation): Promise<UnitDiagnosticsRead | null> {
  return consistent(db, async (trx) => {
    const unit = await trx.selectFrom("authority.unit").selectAll().where("run_id", "=", location.run_id).where("id", "=", location.unit_id).executeTakeFirst();
    if (!unit) return null;
    const [attempts, intents, rejected] = await Promise.all([
      trx.selectFrom("authority.attempt").selectAll().where("run_id", "=", location.run_id).where("unit_id", "=", location.unit_id)
        .orderBy("created_at").orderBy("action_id").orderBy("seq").execute(),
      trx.selectFrom("authority.effect_intent").select(INTENT_STANDING).where("run_id", "=", location.run_id).where("unit_id", "=", location.unit_id)
        .orderBy("action_id").orderBy("seq").execute(),
      trx.selectFrom("authority.ingress_receipt").selectAll().where("run_id", "=", location.run_id).where("unit_id", "=", location.unit_id)
        .where((eb) => eb(eb.ref("result", "->>").key("kind"), "=", "rejected")).orderBy("id").execute(),
    ]);
    return { unit: unit as UnitRecord, attempts: attempts as AttemptRecord[], intents: intents as IntentStanding[], rejected: rejected as IngressReceiptRecord[] };
  });
}

// ---------------------------------------------------------- definitions -----

/** A pinned definition bundle as recorded. */
export interface DefinitionRead { readonly bundle_id: string; readonly digest: string; readonly version: number; readonly source: Workflow; readonly archived_at: Date | null }
export interface PinnedDefinitionRead extends DefinitionRead { readonly checked_program: CompiledWorkflow }
export interface DefinitionReadPage { readonly items: readonly DefinitionRead[]; readonly next: string | null }
const DEFINITION_COLUMNS = ["id as bundle_id", "digest", "version", "source", "archived_at"] as const;

/** One listing is either the archived definitions or the active ones. */
export async function listDefinitions(db: Reader, query: { readonly after: string | null; readonly limit: number; readonly is_archived: boolean }): Promise<DefinitionReadPage> {
  let page = db.selectFrom("authority.definition_bundle").select(DEFINITION_COLUMNS).where("archived_at", query.is_archived ? "is not" : "is", null);
  if (query.after !== null) page = page.where("id", "<", query.after);
  const rows = await page.orderBy("id", "desc").limit(query.limit + 1).execute();
  const items = rows.slice(0, query.limit);
  return { items, next: rows.length > query.limit ? items.at(-1)?.bundle_id ?? null : null };
}

export async function readDefinition(db: Reader, bundle_id: string): Promise<DefinitionRead | null> {
  return await db.selectFrom("authority.definition_bundle").select(DEFINITION_COLUMNS).where("id", "=", bundle_id).executeTakeFirst() ?? null;
}

export async function readPinnedDefinition(db: Reader, run_id: string): Promise<PinnedDefinitionRead | null> {
  return await db.selectFrom("authority.definition_bundle as bundle").innerJoin("authority.run as run", "run.definition_bundle_id", "bundle.id")
    .select(["bundle.id as bundle_id", "bundle.digest", "bundle.version", "bundle.source", "bundle.archived_at", "bundle.checked_program"])
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
