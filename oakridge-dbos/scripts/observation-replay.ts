/**
 * Replays Oakridge's committed event stream into a scratch observation database
 * through this checkout's publisher and observation service, and reports
 * whether delivery reaches the end of the stream or where it stops.
 *
 * Delivery is ordered and the publisher retries a refused event forever, so one
 * event the service cannot take blocks every later one. The development e2e
 * test drives this over a real development run; run it as a command before
 * restarting a live install on new code:
 *
 *   bun oakridge-dbos/scripts/observation-replay.ts [--from-start]
 *
 * It reads the live observation cursor and replays the backlog after it
 * (`--from-start` replays the whole history). The scratch database starts empty,
 * so a decision on a revision the live service captured takes the
 * uncaptured-target path here: this checks deliverability, not identical grading.
 * Nothing is written to the live databases.
 */
import { sql } from "kysely";
import { createApp } from "../../observation/src/http/app";
import { openDatabase as openObservationDatabase, withTenant, type Database as ObservationDatabase } from "../../observation/src/storage/database";
import { migrateEmptyDatabase as migrateObservation } from "../../observation/src/storage/migrate";
import { publishObservationOnce, type ObservationOptions } from "../src/adapters/observation";
import { INITIAL_SOURCE_CURSOR, type SourceEventCursor } from "../src/adapters/observation-wire";
import { openDatabase, type Database } from "../src/storage/database";
import { createScratchDatabase } from "./scratch-database";

/** The delivery the service refused: its position, what it carried, and why. */
export interface RefusedDelivery {
  readonly cursor: SourceEventCursor | null;
  readonly outcome_kind: string | null;
  readonly event_kind: string | null;
  readonly run_id: string | null;
  readonly detail: string;
}

export type ReplayReport =
  | { readonly kind: "reached_head"; readonly delivered: number }
  /** Delivery reached the end, but fewer events than the stream holds in that range: the publisher skipped some. */
  | { readonly kind: "skipped_events"; readonly delivered: number; readonly expected: number }
  | { readonly kind: "stopped"; readonly delivered: number; readonly refused: RefusedDelivery }
  /** Committed events past the reader's visibility horizon stayed hidden, likely behind an open transaction. */
  | { readonly kind: "blocked"; readonly delivered: number; readonly remaining: number };

export interface ReplayInput {
  readonly authority: Database;
  readonly observation: ObservationDatabase;
  readonly namespace: string;
  /** The position delivery resumes after; the initial cursor replays the whole history. */
  readonly start: SourceEventCursor;
  /** How long delivery may stall short of the stream's end before the replay reports it blocked. */
  readonly wait_ms?: number;
}

interface DeliveryShape {
  readonly cursor?: SourceEventCursor;
  readonly outcome?: { readonly kind?: string; readonly event_kind?: string; readonly run_id?: string };
}

const TOKEN = "observation-replay";

/** Delivers every committed event after `start` into an already-migrated observation database. */
export async function replayIntoObservation(input: ReplayInput): Promise<ReplayReport> {
  const tenant = { producer: "oakridge", namespace: input.namespace };
  await withTenant(input.observation, tenant, (trx) => sql`INSERT INTO observation.source_event_cursor
    (producer, namespace, commit_txid, event_id) VALUES (${tenant.producer}, ${tenant.namespace}, ${input.start.commit_txid}::bigint, ${input.start.id})
    ON CONFLICT (producer, namespace) DO UPDATE SET commit_txid = EXCLUDED.commit_txid, event_id = EXCLUDED.event_id`.execute(trx));
  const app = createApp({ db: input.observation, credentials: { ingest: [{ ...tenant, token: TOKEN }], read: [] } });
  // What the last refused delivery carried, and the exception behind a 500, for the report.
  const failure: { exception: string | null; sent: DeliveryShape | null; response: string | null } =
    { exception: null, sent: null, response: null };
  app.onError((error, c) => {
    failure.exception = error instanceof Error ? error.message : String(error);
    return c.json({ error: { code: "internal_error", message: failure.exception } }, 500);
  });
  const fetcher: NonNullable<ObservationOptions["fetcher"]> = async (url, init) => {
    const response = await app.request(new Request(url, init));
    if (response.ok || typeof init?.body !== "string") return response;
    failure.sent = JSON.parse(init.body) as DeliveryShape;
    failure.response = await response.clone().text();
    return response;
  };
  const options: ObservationOptions = { url: "http://observation.replay", namespace: input.namespace, token: TOKEN, fetcher };
  // The stream's end, read without the reader's visibility horizon: the replay is done only once it gets there.
  const end = await readStreamEnd(input.authority);
  const wait_ms = input.wait_ms ?? 30_000;
  let delivered = 0;
  let stalled_since: number | null = null;
  for (;;) {
    try {
      if (await publishObservationOnce(input.authority, options)) { delivered += 1; stalled_since = null; continue; }
      const cursor = await readServiceCursor(app);
      const remaining = end === null ? 0 : await countEvents(input.authority, cursor, end);
      if (remaining === 0) return checkCompleteness(input, cursor, delivered);
      stalled_since ??= Date.now();
      if (Date.now() - stalled_since >= wait_ms) return { kind: "blocked", delivered, remaining };
      await Bun.sleep(500);
    } catch (error) {
      const detail = failure.exception ?? failure.response ?? (error instanceof Error ? error.message : String(error));
      return { kind: "stopped", delivered, refused: { cursor: failure.sent?.cursor ?? null, outcome_kind: failure.sent?.outcome?.kind ?? null,
        event_kind: failure.sent?.outcome?.event_kind ?? null, run_id: failure.sent?.outcome?.run_id ?? null, detail } };
    }
  }
}

/** The last committed event, whether or not the reader can see it yet. */
async function readStreamEnd(authority: Database): Promise<SourceEventCursor | null> {
  const row = await sql<{ txid: string; id: string }>`SELECT commit_txid::text AS txid, id FROM authority.event
    ORDER BY commit_txid DESC, id DESC LIMIT 1`.execute(authority);
  return row.rows[0] ? { commit_txid: row.rows[0].txid, id: row.rows[0].id } : null;
}

async function readServiceCursor(app: ReturnType<typeof createApp>): Promise<SourceEventCursor> {
  const ack = await (await app.request("/v1/sources/oakridge/cursor", { headers: { authorization: `Bearer ${TOKEN}` } })).json() as
    { readonly cursor: SourceEventCursor };
  return ack.cursor;
}

/** Events strictly after `after` and up to and including `through`, in numeric commit order. */
async function countEvents(authority: Database, after: SourceEventCursor, through: SourceEventCursor): Promise<number> {
  const counted = await sql<{ count: string }>`SELECT count(*)::text AS count FROM authority.event
    WHERE (commit_txid, id) > (${after.commit_txid}::bigint, ${after.id})
    AND (commit_txid, id) <= (${through.commit_txid}::bigint, ${through.id})`.execute(authority);
  return Number(counted.rows[0]?.count ?? 0);
}

/**
 * Counts the stream independently of the publisher: every event between the start
 * and the service's final position must have been delivered exactly once.
 */
async function checkCompleteness(input: ReplayInput, cursor: SourceEventCursor, delivered: number): Promise<ReplayReport> {
  const expected = await countEvents(input.authority, input.start, cursor);
  return expected === delivered ? { kind: "reached_head", delivered } : { kind: "skipped_events", delivered, expected };
}

/** The live service's position, read without writing. */
async function readLiveCursor(observation_url: string, namespace: string): Promise<SourceEventCursor> {
  const tenant = { producer: "oakridge", namespace };
  const live = openObservationDatabase(observation_url);
  try {
    const row = await withTenant(live, tenant, (trx) => trx.selectFrom("observation.source_event_cursor")
      .select(["commit_txid", "event_id"]).where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .executeTakeFirst());
    return row ? { commit_txid: String(row.commit_txid), id: row.event_id } : INITIAL_SOURCE_CURSOR;
  } finally { await live.destroy(); }
}

async function main(args: readonly string[]): Promise<ReplayReport> {
  const authority_url = process.env.DBOS_SYSTEM_DATABASE_URL;
  const observation_url = process.env.OBSERVATION_DATABASE_URL;
  if (!authority_url || !observation_url) throw new Error("DBOS_SYSTEM_DATABASE_URL and OBSERVATION_DATABASE_URL are required");
  const namespace = process.env.OAKRIDGE_OBSERVATION_NAMESPACE ?? "default";
  const start = args.includes("--from-start") ? INITIAL_SOURCE_CURSOR : await readLiveCursor(observation_url, namespace);
  const scratch = await createScratchDatabase(observation_url, `observation_replay_${Date.now()}`);
  const authority = openDatabase(authority_url);
  const observation = openObservationDatabase(scratch.url);
  try {
    await migrateObservation(observation);
    return await replayIntoObservation({ authority, observation, namespace, start });
  } finally {
    await observation.destroy();
    await authority.destroy();
    await scratch.drop();
  }
}

if (import.meta.main) {
  const report = await main(process.argv.slice(2));
  console.log(JSON.stringify(report, null, 2));
  if (report.kind !== "reached_head") process.exitCode = 1;
}
