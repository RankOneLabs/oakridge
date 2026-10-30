import { afterAll, beforeAll, expect, test } from "bun:test";
import { jsonText, openDatabase } from "../src/storage/database";
import { readCommittedEventsAfter } from "../src/storage/read-store";
import { launch, openAuthority, pinSample, type Authority } from "./authority-fixture";

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
  const [nines, boundary] = [event(99_999), event(100_000)];
  await authority.db.insertInto("authority.event").values([boundary, nines]).execute();
  const rows = await readCommittedEventsAfter(authority.db, "authority.event", { after: { commit_txid: "99998", id: "" }, limit: 2 });
  expect(rows.map((row) => row.commit_txid)).toEqual(["99999", "100000"]);
});
