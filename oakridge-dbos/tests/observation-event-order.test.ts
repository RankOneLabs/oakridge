import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "kysely";
import { jsonText, openDatabase } from "../src/storage/database";
import { readCommittedEventsAfter } from "../src/storage/read-store";
import { launch, openAuthority, pinSample, scratchDatabase, type Authority } from "./authority-fixture";
import { openDatabase as openObservationDatabase } from "../../observation/src/storage/database";
import { migrateEmptyDatabase as migrateObservation } from "../../observation/src/storage/migrate";
import { replayIntoObservation } from "../scripts/observation-replay";

let authority: Authority;
beforeAll(async () => { authority = await openAuthority(); });
afterAll(async () => { await authority.close(); });

test("a lower transaction id remains unread until it commits, then both rows are delivered", async () => {
  const { bundle_id } = await pinSample(authority);
  const { run_id } = await launch(authority, { bundle_id, request_id: crypto.randomUUID(), input: { topic: "order" } });
  const starting = await authority.db.selectFrom("authority.event").select(["id", "commit_txid"])
    .where("run_id", "=", run_id).orderBy("commit_txid", "desc").executeTakeFirstOrThrow();
  const cursor = { commit_txid: String(starting.commit_txid), id: starting.id };
  const holder = openDatabase(authority.url);
  let inserted!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { inserted = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const older = crypto.randomUUID();
  const newer = crypto.randomUUID();
  const pending = holder.transaction().execute(async (trx) => {
    await trx.insertInto("authority.event").values({ id: older, run_id, unit_id: null,
      payload: jsonText({ kind: "cancel_requested" }), writer: jsonText({ kind: "operator", subject: "test" }) }).execute();
    inserted();
    await gate;
  });
  await ready;
  try {
    await authority.db.insertInto("authority.event").values({ id: newer, run_id, unit_id: null,
      payload: jsonText({ kind: "cancel_requested" }), writer: jsonText({ kind: "operator", subject: "test" }) }).execute();
    expect(await readCommittedEventsAfter(authority.db, "authority.event", { after: cursor, limit: 10 })).toEqual([]);
    release();
    await pending;
    let rows = await readCommittedEventsAfter(authority.db, "authority.event", { after: cursor, limit: 10 });
    const deadline = Date.now() + 30_000;
    while (rows.length < 2 && Date.now() < deadline) {
      await Bun.sleep(20);
      rows = await readCommittedEventsAfter(authority.db, "authority.event", { after: cursor, limit: 10 });
    }
    const after = rows.at(-1)!;
    expect({ ids: rows.map((row) => row.id), replay: await readCommittedEventsAfter(authority.db, "authority.event",
      { after: { commit_txid: after.commit_txid, id: after.id }, limit: 10 }) }).toEqual({ ids: [older, newer], replay: [] });
  } finally { release(); await pending; await holder.destroy(); }
});

test("events are read in numeric commit order across a digit boundary", async () => {
  const { bundle_id } = await pinSample(authority);
  const { run_id } = await launch(authority, { bundle_id, request_id: crypto.randomUUID(), input: { topic: "digits" } });
  const event = (commit_txid: number) => ({ id: crypto.randomUUID(), run_id, unit_id: null, commit_txid,
    payload: jsonText({ kind: "cancel_requested" as const }), writer: jsonText({ kind: "operator" as const, subject: "test" }) });
  // Every server's transaction ids are past 100 (a new cluster starts near 700), so both rows are visible.
  const [nines, boundary] = [event(99), event(100)];
  await authority.db.insertInto("authority.event").values([boundary, nines]).execute();
  const rows = await readCommittedEventsAfter(authority.db, "authority.event", { after: { commit_txid: "98", id: "" }, limit: 2 });
  expect(rows.map((row) => row.commit_txid)).toEqual(["99", "100"]);
});

test("a text output alias cannot shadow numeric commit order at a long digit boundary", async () => {
  const ordered = await sql<{ commit_txid_text: string }>`SELECT commit_txid::text AS commit_txid_text
    FROM (VALUES (1000005::bigint), (100001::bigint)) AS events(commit_txid)
    ORDER BY commit_txid`.execute(authority.db);
  const shadowed = await sql<{ commit_txid: string }>`SELECT commit_txid::text AS commit_txid
    FROM (VALUES (1000005::bigint), (100001::bigint)) AS events(commit_txid)
    ORDER BY commit_txid`.execute(authority.db);
  expect(ordered.rows.map((row) => row.commit_txid_text)).toEqual(["100001", "1000005"]);
  expect(shadowed.rows.map((row) => row.commit_txid)).toEqual(["1000005", "100001"]);
});

test("a replay reports blocked, not finished, while an open transaction hides committed events", async () => {
  const { bundle_id } = await pinSample(authority);
  const { run_id } = await launch(authority, { bundle_id, request_id: crypto.randomUUID(), input: { topic: "blocked" } });
  const latest = await authority.db.selectFrom("authority.event").select(["id", "commit_txid"])
    .orderBy("commit_txid", "desc").orderBy("id", "desc").executeTakeFirstOrThrow();
  const target = await scratchDatabase();
  const observation = openObservationDatabase(target.url);
  const holder = openDatabase(authority.url);
  let inserted!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { inserted = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const cancel = { run_id, unit_id: null, payload: jsonText({ kind: "cancel_requested" as const }),
    writer: jsonText({ kind: "operator" as const, subject: "test" }) };
  const pending = holder.transaction().execute(async (trx) => {
    await trx.insertInto("authority.event").values({ id: crypto.randomUUID(), ...cancel }).execute();
    inserted();
    await gate;
  });
  try {
    await ready;
    await authority.db.insertInto("authority.event").values({ id: crypto.randomUUID(), ...cancel }).execute();
    await migrateObservation(observation);
    const report = await replayIntoObservation({ authority: authority.db, observation, namespace: "blocked",
      start: { commit_txid: String(latest.commit_txid), id: latest.id }, wait_ms: 500 });
    expect(report).toEqual({ kind: "blocked", delivered: 0, remaining: 1 });
  } finally { release(); await pending; await holder.destroy(); await observation.destroy(); await target.drop(); }
});
