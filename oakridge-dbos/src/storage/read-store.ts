import { sql, type ExpressionBuilder, type Kysely, type Selectable } from "kysely";
import type { ParsedWorkflow, UnitStatus, Workflow } from "../core-client/core-types";
import type { ActionId, DecisionId, DefinitionBundleId, EventId, IngressId, IntentId, ProjectId, RevisionId, RunId, UnitId } from "../domain/primitives";
import { TERMINAL_UNIT_STATUSES } from "../domain/unit-status";
import type { CommitFaultNotice, OperatorEventDeliveryRow } from "../projections/operator-event";
import type { RunEventCursor } from "../projections/run-event";
import type { SessionHold, SessionRunLocation } from "../projections/session-hold";
import type { DB } from "./db-types";
import { anyOf, type DatabaseTransaction } from "./database";
import { OWED_STATUSES } from "./executor-store";
import type { CompiledWorkflow, StallRecord, WantedWorkers } from "./json-column-types";
import type { ArtifactRevisionRecord, AttemptRecord, EffectIntentRecord, EventRecord, IngressReceiptRecord, ReviewDecisionRecord, RunRecord,
  UnitDependencyRecord, UnitRecord } from "./schema-records";

type Reader = Kysely<DB> | DatabaseTransaction;
type Row<Table extends keyof DB> = Selectable<DB[Table]>;
/** Brand the identity columns once as rows cross from SQL into projections. */
const runRecord = (row: Row<"authority.run">): RunRecord => ({ ...row, id: row.id as RunId,
  definition_bundle_id: row.definition_bundle_id as DefinitionBundleId, project_id: row.project_id as ProjectId | null,
  root_unit_id: row.root_unit_id as UnitId | null });
const summaryRun = (row: Omit<Row<"authority.run">, "config">): RunSummaryRecord => ({ ...row, id: row.id as RunId,
  definition_bundle_id: row.definition_bundle_id as DefinitionBundleId, project_id: row.project_id as ProjectId | null,
  root_unit_id: row.root_unit_id as UnitId | null });
const unitRecord = (row: Row<"authority.unit">): UnitRecord => ({ ...row, id: row.id as UnitId,
  run_id: row.run_id as RunId, parent_id: row.parent_id as UnitId | null });
const summaryUnit = (row: Omit<Row<"authority.unit">, "input">): UnitSummaryRecord => ({ ...row, id: row.id as UnitId,
  run_id: row.run_id as RunId, parent_id: row.parent_id as UnitId | null });
const attemptRecord = (row: Row<"authority.attempt">): AttemptRecord => ({ ...row, action_id: row.action_id as ActionId,
  run_id: row.run_id as RunId, unit_id: row.unit_id as UnitId });
const revisionRecord = (row: Row<"authority.artifact_revision">): ArtifactRevisionRecord => ({ ...row, id: row.id as RevisionId,
  run_id: row.run_id as RunId, unit_id: row.unit_id as UnitId, by_id: row.by_id as ActionId | null,
  predecessor_id: row.predecessor_id as RevisionId | null, subject: row.subject as RevisionId | null });
const revisionRef = (row: Pick<Row<"authority.artifact_revision">, "id" | "run_id" | "unit_id" | "artifact" | "seq" | "created_at">): RevisionRef =>
  ({ ...row, id: row.id as RevisionId, run_id: row.run_id as RunId, unit_id: row.unit_id as UnitId });
const decisionRecord = (row: Row<"authority.review_decision">): ReviewDecisionRecord => ({ ...row, id: row.id as DecisionId,
  run_id: row.run_id as RunId, unit_id: row.unit_id as UnitId, target_revision_id: row.target_revision_id as RevisionId });
const eventRecord = (row: Row<"authority.event">): EventRecord => ({ ...row, id: row.id as EventId,
  run_id: row.run_id as RunId, unit_id: row.unit_id as UnitId | null });
const dependencyRecord = (row: Row<"authority.unit_dependency">): UnitDependencyRecord => ({ ...row,
  run_id: row.run_id as RunId, unit_id: row.unit_id as UnitId, depends_on_id: row.depends_on_id as UnitId });
const receiptRecord = (row: Row<"authority.ingress_receipt">): IngressReceiptRecord => ({ ...row,
  run_id: row.run_id as RunId, unit_id: row.unit_id as UnitId | null });

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
export interface PinnedSource { readonly digest: string; readonly workflow: Workflow; readonly parsed_workflow: ParsedWorkflow }
/** An operator retry, in the order it was requested. */
/** An operator's retry request; `retry_id` is its ingress id, the identity an attempt's retry cause names. */
export interface RetryRequest { readonly unit_id: UnitId; readonly worker: string; readonly retry_id: IngressId }
/** An event step refused because the run could not advance past it; `unit_id` is the unit the event addressed. */
export interface StallRefusal { readonly unit_id: UnitId | null; readonly ingress_id: IngressId; readonly reason: string; readonly stall: StallRecord }
/** A faulted commit recorded against a run, and when it was recorded. */
export interface RecordedFault { readonly notice: CommitFaultNotice; readonly recorded_at: Date }
/** The latest event committed on one unit of a run; `unit_id` null for the events that address the run (launch, cancel). */
export interface LatestUnitEvent { readonly unit_id: string | null; readonly event_id: string; readonly created_at: Date }
/** A run as lists read it: launch input and identity, without config. */
export type RunSummaryRecord = Omit<RunRecord, "config">;
/** A unit as lists read it: everything but its resolved input. */
export type UnitSummaryRecord = Omit<UnitRecord, "input">;
/** A revision as lists read it: where it is and when, never its body. */
export type RevisionRef = Pick<ArtifactRevisionRecord, "id" | "run_id" | "unit_id" | "artifact" | "seq" | "created_at">;
/**
 * One launched run as the run list, the run view and the inbox read it: what
 * RunView and attention derive from, without revision bodies, decisions or
 * resolved unit inputs. A page of runs costs what its summaries need.
 */
export interface RunSummaryRead {
  readonly run: RunSummaryRecord;
  readonly definition: PinnedSource;
  readonly units: readonly UnitSummaryRecord[];
  readonly attempts: readonly AttemptRecord[];
  readonly revisions: readonly RevisionRef[];
  readonly retries: readonly RetryRequest[];
  /** Refusals that recorded where the run stopped advancing, in the order they were refused. */
  readonly stalls: readonly StallRefusal[];
  /** Faulted commits recorded against the run, in the order they faulted. */
  readonly faults: readonly RecordedFault[];
  /** Latest event on each unit and at run level, for recency and stall/fault checks. */
  readonly latest_events: readonly LatestUnitEvent[];
}
/**
 * One launched run and everything recorded against it, each in the order
 * commit wrote it: the source of the unit, artifact and inspect projections.
 */
export interface RunRead extends RunSummaryRead {
  readonly run: RunRecord;
  readonly units: readonly UnitRecord[];
  readonly dependencies: readonly UnitDependencyRecord[];
  readonly revisions: readonly ArtifactRevisionRecord[];
  readonly decisions: readonly ReviewDecisionRecord[];
}

const RUN_SUMMARY_COLUMNS = ["run.id", "run.definition_bundle_id", "run.project_id", "run.root_unit_id",
  "run.created_at", "run.archived_at", "run.input"] as const;
const UNIT_SUMMARY_COLUMNS = ["id", "run_id", "parent_id", "declaration", "stage", "collection_key", "pool", "status", "blocked_reason", "review_prompts"] as const;
const REVISION_REF_COLUMNS = ["id", "run_id", "unit_id", "artifact", "seq", "created_at"] as const;
const of = <Row extends { readonly run_id: string }>(rows: readonly Row[], run_id: string): Row[] => rows.filter((row) => row.run_id === run_id);

/**
 * Launched runs as lists read them, in the order asked; a run row with no
 * root is not a run to the operator. One query per table for every run
 * asked, so a page of runs costs what one run does.
 */
async function runSummaryReads(trx: DatabaseTransaction, run_ids: readonly string[]): Promise<readonly RunSummaryRead[]> {
  if (run_ids.length === 0) return [];
  const ids = anyOf(run_ids);
  // Action ids are hashes: attempts and revisions read in the order commit wrote them.
  const [runs, units, attempts, revisions, retries, stalls, faults] = await Promise.all([
    trx.selectFrom("authority.run as run").innerJoin("authority.definition_bundle as bundle", "bundle.id", "run.definition_bundle_id")
      .select(RUN_SUMMARY_COLUMNS).select(["bundle.digest", "bundle.source", "bundle.checked_program"])
      .where("run.id", "=", ids).where("run.root_unit_id", "is not", null).execute(),
    trx.selectFrom("authority.unit").select(UNIT_SUMMARY_COLUMNS).where("run_id", "=", ids).orderBy("id").execute(),
    trx.selectFrom("authority.attempt").selectAll().where("run_id", "=", ids).orderBy("created_at").orderBy("action_id").orderBy("seq").execute(),
    trx.selectFrom("authority.artifact_revision").select(REVISION_REF_COLUMNS).where("run_id", "=", ids).orderBy("created_at").orderBy("id").execute(),
    trx.selectFrom("authority.event").select(["run_id", "unit_id", "ingress_id", "payload"]).where("run_id", "=", ids)
      .where((eb) => eb(eb.ref("payload", "->>").key("kind"), "=", "retry_requested")).orderBy("created_at").orderBy("id").execute(),
    trx.selectFrom("authority.ingress_receipt").select(["run_id", "unit_id", "ingress_id", "result"]).where("run_id", "=", ids)
      .where((eb) => eb(eb.ref("result", "->>").key("kind"), "=", "rejected"))
      .where((eb) => eb(eb.ref("result", "->").key("stall"), "is not", null)).execute(),
    trx.selectFrom("authority.operator_event").select(["run_id", "payload", "created_at"]).where("run_id", "=", ids).where((eb) => eb(eb.ref("payload", "->>").key("kind"), "=", "commit_fault"))
      .orderBy("created_at").orderBy("id").execute(),
  ]);
  const latest_events = await trx.selectFrom("authority.event").distinctOn(["run_id", "unit_id"])
    .select(["run_id", "unit_id", "id", "created_at"]).where("run_id", "=", ids)
    .orderBy("run_id").orderBy("unit_id").orderBy("created_at", "desc").orderBy("id", "desc").execute();
  return run_ids.flatMap((run_id) => {
    const found = runs.find((run) => run.id === run_id);
    if (!found) return [];
    const { digest, source, checked_program, ...run } = found;
    return [{ run: summaryRun(run), definition: { digest, workflow: source, parsed_workflow: checked_program.workflow },
      units: of(units, run_id).map(summaryUnit), attempts: of(attempts, run_id).map(attemptRecord), revisions: of(revisions, run_id).map(revisionRef),
      retries: of(retries, run_id).flatMap((retry) => retry.payload.kind === "retry_requested" && retry.unit_id !== null && retry.ingress_id !== null
        ? [{ unit_id: retry.unit_id as UnitId, worker: retry.payload.worker, retry_id: retry.ingress_id as IngressId }] : []),
      stalls: of(stalls, run_id).flatMap(({ unit_id, ingress_id, result }) => result.kind === "rejected" && result.stall
        ? [{ unit_id: unit_id as UnitId | null, ingress_id: ingress_id as IngressId, reason: result.reason, stall: result.stall }] : [])
        .sort((left, right) => left.stall.refused_at.localeCompare(right.stall.refused_at)),
      faults: faults.flatMap((row) => row.run_id === run_id && row.payload.kind === "commit_fault"
        ? [{ notice: row.payload.data, recorded_at: row.created_at }] : []),
      latest_events: of(latest_events, run_id).map(({ unit_id, id, created_at }) => ({ unit_id, event_id: id, created_at })) }];
  });
}

/** One run with everything recorded against it: its summary read, and the rows the summary leaves out. */
async function runRead(trx: DatabaseTransaction, run_id: string): Promise<RunRead | null> {
  const [summary] = await runSummaryReads(trx, [run_id]);
  if (!summary) return null;
  const [run, units, dependencies, revisions, decisions] = await Promise.all([
    trx.selectFrom("authority.run").selectAll().where("id", "=", run_id).executeTakeFirstOrThrow(),
    trx.selectFrom("authority.unit").selectAll().where("run_id", "=", run_id).orderBy("id").execute(),
    trx.selectFrom("authority.unit_dependency").selectAll().where("run_id", "=", run_id).orderBy("unit_id").orderBy("depends_on_id").execute(),
    trx.selectFrom("authority.artifact_revision").selectAll().where("run_id", "=", run_id).orderBy("created_at").orderBy("id").execute(),
    trx.selectFrom("authority.review_decision").selectAll().where("run_id", "=", run_id).orderBy("created_at").orderBy("id").execute(),
  ]);
  return { ...summary, run: runRecord(run), units: units.map(unitRecord), dependencies: dependencies.map(dependencyRecord),
    revisions: revisions.map(revisionRecord), decisions: decisions.map(decisionRecord) };
}

export async function readRun(db: Kysely<DB>, run_id: string): Promise<RunRead | null> {
  return consistent(db, (trx) => runRead(trx, run_id));
}

/** The inbox projection for one run without loading revision bodies or launch input. */
export async function readRunSummary(db: Kysely<DB>, run_id: string): Promise<RunSummaryRead | null> {
  return consistent(db, async (trx) => (await runSummaryReads(trx, [run_id]))[0] ?? null);
}

/** Summaries for the named runs in one snapshot, with the same rows as a run-list page. */
export async function readRunSummaries(db: Kysely<DB>, run_ids: readonly string[]): Promise<readonly RunSummaryRead[]> {
  return consistent(db, (trx) => runSummaryReads(trx, run_ids));
}

export interface RunPageQuery { readonly after: { readonly created_at: string; readonly id: string } | null; readonly limit: number; readonly is_archived: boolean }
export interface RunReadPage { readonly items: readonly RunSummaryRead[]; readonly next: { readonly created_at: string; readonly id: string } | null }
/** PostgreSQL's full timestamp, as a stable UTC cursor string rather than a millisecond Date. */
function cursorTimestamp<Table extends "authority.run" | "authority.event">(eb: ExpressionBuilder<DB, Table>) {
  return eb.fn<string>("to_char", [eb.fn("timezone", [eb.val("UTC"), eb.ref("created_at")]),
    eb.val('YYYY-MM-DD"T"HH24:MI:SS.US"Z"')]).as("cursor_created_at");
}
function cursorTimestampValue<Table extends "authority.run" | "authority.event">(eb: ExpressionBuilder<DB, Table>, value: string) {
  return eb.cast<Date>(eb.val(value), "timestamptz");
}
/** Newest first; one listing is either the archived runs or the active ones. */
export async function listRuns(db: Kysely<DB>, query: RunPageQuery): Promise<RunReadPage> {
  return consistent(db, async (trx) => {
    let page = trx.selectFrom("authority.run").select(["id", "created_at"])
      .select(cursorTimestamp)
      .where("root_unit_id", "is not", null)
      .where("archived_at", query.is_archived ? "is not" : "is", null);
    const after = query.after;
    if (after) page = page.where((eb) => eb(eb.refTuple("created_at", "id"), "<", eb.tuple(cursorTimestampValue(eb, after.created_at), after.id)));
    const rows = await page.orderBy("created_at", "desc").orderBy("id", "desc").limit(query.limit + 1).execute();
    const selected = rows.slice(0, query.limit);
    const items = await runSummaryReads(trx, selected.map((row) => row.id));
    const last = selected.at(-1);
    return { items, next: rows.length > query.limit && last ? { created_at: last.cursor_created_at, id: last.id } : null };
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
    return { run, events: events.map(eventRecord) };
  });
}

export interface LiveRunQuery { readonly after: string | null; readonly limit: number }
export interface LiveRunPage { readonly items: readonly RunSummaryRead[]; readonly next: string | null }
/** Launched runs that are neither finished nor archived, by id: what the inbox derives its items from. */
export async function listLiveRuns(db: Kysely<DB>, query: LiveRunQuery): Promise<LiveRunPage> {
  return consistent(db, async (trx) => {
    let page = trx.selectFrom("authority.run as run").innerJoin("authority.unit as root", (join) =>
      join.onRef("root.run_id", "=", "run.id").onRef("root.id", "=", "run.root_unit_id"))
      .select("run.id").where("run.archived_at", "is", null)
      .where((eb) => eb(eb.ref("root.status", "->>").key("kind"), "not in", TERMINAL_UNIT_STATUSES));
    if (query.after !== null) page = page.where("run.id", ">", query.after);
    const rows = await page.orderBy("run.id").limit(query.limit + 1).execute();
    const selected = rows.slice(0, query.limit);
    const items = await runSummaryReads(trx, selected.map((row) => row.id));
    return { items, next: rows.length > query.limit ? selected.at(-1)?.id ?? null : null };
  });
}

export interface RunStanding { readonly status: UnitStatus; readonly is_launched: boolean }
export async function readRunStanding(db: Reader, run_id: string): Promise<RunStanding | null> {
  const run = await db.selectFrom("authority.run as run").leftJoin("authority.unit as root", (join) =>
    join.onRef("root.run_id", "=", "run.id").onRef("root.id", "=", "run.root_unit_id"))
    .select(["run.root_unit_id", "root.status as root_status"]).where("run.id", "=", run_id).executeTakeFirst();
  return run ? { status: run.root_status ?? { kind: "not_started" }, is_launched: run.root_unit_id !== null } : null;
}

/** Runs the executor must carry: launched and not terminal, or still owed an unsettled intent. One run when named. */
export async function listRunsNeedingWork(db: Reader, filter: { readonly run_id?: string } = {}): Promise<readonly RunId[]> {
  let runs = db.selectFrom("authority.run as run").innerJoin("authority.unit as root", (join) =>
    join.onRef("root.run_id", "=", "run.id").onRef("root.id", "=", "run.root_unit_id"))
    .select("run.id");
  if (filter.run_id !== undefined) runs = runs.where("run.id", "=", filter.run_id);
  const rows = await runs
    .where((eb) => eb.or([
      eb(eb.ref("root.status", "->>").key("kind"), "not in", TERMINAL_UNIT_STATUSES),
      eb.exists(eb.selectFrom("authority.effect_intent as intent").select("intent.id").whereRef("intent.run_id", "=", "run.id")
        .where("intent.status", "in", OWED_STATUSES)),
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
        .where("created_at", "<=", opened_at).orderBy("artifact").orderBy("seq", "desc").execute(),
    ]);
    return { earlier_attempts: earlier_attempts.map(attemptRecord), latest: latest.map(revisionRecord) };
  });
}

/** The latest revision of one artifact, which a code worker's output names as its predecessor; null before the first. */
export async function readLatestRevisionId(db: Reader, input: UnitLocation & { readonly artifact: string }): Promise<string | null> {
  const latest = await db.selectFrom("authority.artifact_revision").select("id").where("run_id", "=", input.run_id)
    .where("unit_id", "=", input.unit_id).where("artifact", "=", input.artifact)
    .orderBy("seq", "desc").executeTakeFirst();
  return latest?.id ?? null;
}

/** The running attempt a publication secret speaks for, and the kbbl session it was minted for. */
export interface SessionAttempt { readonly action_id: string; readonly seq: number; readonly unit_id: string; readonly kbbl_session_id: string }
/**
 * Resolve a publication secret's hash to its session's running attempt. The
 * secret is minted per kbbl session, so it names whichever attempt of that
 * session is running now; with none running, the secret speaks for nothing.
 */
export async function readSessionAttempt(db: Kysely<DB>, input: { readonly run_id: string; readonly unit_id: string; readonly secret_hash: string }): Promise<SessionAttempt | null> {
  return consistent(db, async (trx) => {
    const minted = await trx.selectFrom("authority.attempt").select("kbbl_session_id").where("run_id", "=", input.run_id)
      .where("publication_secret_hash", "=", input.secret_hash).where("kbbl_session_id", "is not", null).executeTakeFirst();
    if (!minted?.kbbl_session_id) return null;
    const running = await trx.selectFrom("authority.attempt").select(["action_id", "seq", "unit_id"]).where("run_id", "=", input.run_id)
      .where("kbbl_session_id", "=", minted.kbbl_session_id).where("unit_id", "=", input.unit_id)
      .where((eb) => eb(eb.ref("status", "->>").key("kind"), "=", "running"))
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

/** A session's latest attempt location, including ended attempts, for navigation. */
export async function readSessionRunLocation(db: Kysely<DB>, session_id: string): Promise<SessionRunLocation | null> {
  const attempt = await db.selectFrom("authority.attempt").select(["run_id", "unit_id"])
    .where("kbbl_session_id", "=", session_id).orderBy("created_at", "desc").orderBy("action_id", "desc").executeTakeFirst();
  return attempt ? { run_id: attempt.run_id as RunId, unit_id: attempt.unit_id as UnitId } : null;
}

/** Events newest first: a run's, or one unit's. A launch or cancel names no unit, so it is in the run's history only. */
export interface HistoryQuery { readonly run_id: string; readonly unit_id: string | null; readonly after: HistoryCursor | null; readonly limit: number }
export interface HistoryCursor { readonly created_at: string; readonly id: string }
export interface HistoryEntry { readonly event: EventRecord; readonly wanted: readonly { readonly unit_id: string; readonly actions: WantedWorkers }[] }
export interface HistoryPage { readonly items: readonly HistoryEntry[]; readonly next: HistoryCursor | null }
/** Null when the named unit is not part of the run. */
export async function readHistory(db: Kysely<DB>, query: HistoryQuery): Promise<HistoryPage | null> {
  return consistent(db, async (trx) => {
    if (query.unit_id !== null) {
      const unit = await trx.selectFrom("authority.unit").select("id").where("run_id", "=", query.run_id).where("id", "=", query.unit_id).executeTakeFirst();
      if (!unit) return null;
    }
    let page = trx.selectFrom("authority.event").selectAll()
      .select(cursorTimestamp)
      .where("run_id", "=", query.run_id);
    if (query.unit_id !== null) page = page.where("unit_id", "=", query.unit_id);
    const after = query.after;
    if (after) page = page.where((eb) => eb(eb.refTuple("created_at", "id"), "<", eb.tuple(cursorTimestampValue(eb, after.created_at), after.id)));
    const rows = await page.orderBy("created_at", "desc").orderBy("id", "desc").limit(query.limit + 1).execute();
    const events = rows.slice(0, query.limit).map(eventRecord);
    const event_ids = events.map((event) => event.id);
    const wanted = event_ids.length === 0 ? [] : await trx.selectFrom("authority.wanted_log").select(["event_id", "unit_id", "actions"])
      .where("run_id", "=", query.run_id).where("event_id", "=", anyOf(event_ids)).orderBy("unit_id").execute();
    const last = rows[query.limit - 1];
    return { items: events.map((event) => ({ event, wanted: wanted.filter((row) => row.event_id === event.id)
        .filter((row) => query.unit_id === null || row.unit_id === query.unit_id).map((row) => ({ unit_id: row.unit_id, actions: row.actions })) })),
      next: rows.length > query.limit && last ? { created_at: last.cursor_created_at, id: last.id } : null };
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
    return { unit: unitRecord(unit), attempts: attempts.map(attemptRecord),
      intents: intents.map((row) => ({ ...row, id: row.id as IntentId, action_id: row.action_id as ActionId })),
      rejected: rejected.map(receiptRecord) };
  });
}

// ---------------------------------------------------------- definitions -----

/** A pinned definition bundle as recorded. */
export interface DefinitionRead { readonly bundle_id: string; readonly digest: string; readonly source: Workflow;
  readonly checked_program: CompiledWorkflow; readonly archived_at: Date | null }
export type PinnedDefinitionRead = DefinitionRead;
export interface DefinitionReadPage { readonly items: readonly DefinitionRead[]; readonly next: string | null }
const DEFINITION_COLUMNS = ["id as bundle_id", "digest", "source", "checked_program", "archived_at"] as const;

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
  const rows = await db.selectFrom("authority.operator_event").select(["id", "payload", "commit_txid",
    sql<boolean>`coalesce(pg_visible_in_snapshot(commit_txid::text::xid8, ${subscription_snapshot}::pg_snapshot), false)`.as("was_visible_at_subscription")])
    .where((eb) => eb(eb.refTuple("commit_txid", "id"), ">", eb.tuple(eb.cast<number>(eb.val(after.commit_txid), "bigint"), after.id)))
    .where("commit_txid", "<", sql<number>`pg_snapshot_xmin(pg_current_snapshot())::text::bigint`)
    .orderBy("commit_txid").orderBy("id").limit(input.limit).execute();
  return rows.map((row) => ({ id: row.id, payload: row.payload, commit_txid: String(row.commit_txid),
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
