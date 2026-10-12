import { afterAll, beforeAll, expect, test } from "bun:test";
import { Hono } from "hono";
import type { DefinitionBundleId, RunId } from "../src/domain/primitives";
import { installEventStream } from "../src/http/events";
import type { OperatorEventPayload } from "../src/projections/operator-event";
import type { RunEvent } from "../src/projections/run-event";
import { jsonText, openDatabase, type DatabaseTransaction } from "../src/storage/database";
import { setRunArchived } from "../src/storage/registry-store";
import { executor, launch, openAuthority, pinSample, submitter, unitOf, type Authority } from "./authority-fixture";

let authority: Authority;
let bundle_id: DefinitionBundleId;
let app: Hono;
beforeAll(async () => {
  authority = await openAuthority();
  ({ bundle_id } = await pinSample(authority));
  app = new Hono();
  installEventStream(app, { db: authority.db, timing: { poll_ms: 20, heartbeat_ms: 1_000 } });
});
afterAll(async () => { await authority.close(); });

async function launched(): Promise<RunId> {
  const { run_id } = await launch(authority, { bundle_id, request_id: crypto.randomUUID(), input: { topic: "Oakridge" } });
  return run_id;
}
const announce = (db: Pick<DatabaseTransaction, "insertInto">, key: string, payload: OperatorEventPayload) =>
  db.insertInto("authority.operator_event").values({ id: crypto.randomUUID(), run_id: null, run_key: key, event_key: payload.kind, payload: jsonText(payload) }).execute();

interface RawFrame { readonly id: string; readonly event: string; readonly data: { readonly replay: boolean; readonly [key: string]: unknown } }
/** Reads SSE frames from an already subscribed stream. */
async function readFramesFromReader(reader: ReadableStreamDefaultReader<Uint8Array>, count: number): Promise<readonly RawFrame[]> {
  const decoder = new TextDecoder();
  const frames: RawFrame[] = [];
  let buffer = "";
  while (frames.length < count) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const field = (name: string) => block.split("\n").find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2);
      if (field("event") && field("id") && field("data")) frames.push({ id: field("id")!, event: field("event")!, data: JSON.parse(field("data")!) });
    }
  }
  return frames;
}
async function readFrames(response: Response, count: number): Promise<readonly RawFrame[]> {
  const reader = response.body!.getReader();
  try { return await readFramesFromReader(reader, count); }
  finally { await reader.cancel(); }
}

test("the stream delivers events committed after subscribing and resumes from a frame's id", async () => {
  const run_id = await launched();
  const live = await app.request("/events");
  await Bun.sleep(50); // the subscriber starts from now
  const action = `${unitOf(run_id, "document")}:writer:Initial:Missing`;
  await submitter(authority)({ run_id, event: { kind: "worker_started", action, kbbl_session_id: "sid" }, writer: executor(action) });
  const [started] = await readFrames(live, 1);
  const fresh = await app.request("/events");
  await Bun.sleep(50); // subscribed after the start committed, so it must not replay it
  await submitter(authority)({ run_id, event: { kind: "cancel_requested" } });
  const [cancelled] = await readFrames(fresh, 1);
  const [resumed] = await readFrames(await app.request("/events", { headers: { "last-event-id": started!.id } }), 1);
  const event = (frame: RawFrame | undefined) => frame?.data as unknown as RunEvent & { readonly replay: boolean };
  expect({ started: [event(started)?.kind, event(started)?.replay], cancelled: [event(cancelled)?.kind, event(cancelled)?.run_status],
    resumed: event(resumed)?.event_id === event(cancelled)?.event_id,
    malformed: (await app.request("/events", { headers: { "last-event-id": "not-a-cursor" } })).status })
    .toEqual({ started: ["worker_started", false], cancelled: ["cancel_requested", "cancelled"], resumed: true, malformed: 400 });
});

test("one Last-Event-ID replays invalidate and run_event frames in order", async () => {
  const run_id = await launched();
  const [newest] = await authority.db.selectFrom("authority.operator_event").select(["id", "commit_txid"])
    .orderBy("commit_txid", "desc").orderBy("id", "desc").limit(1).execute();
  const cursor = Buffer.from(JSON.stringify({ id: newest!.id, commit_txid: String(newest!.commit_txid) })).toString("base64url");
  await setRunArchived(authority.db, run_id, true);
  await submitter(authority)({ run_id, event: { kind: "cancel_requested" } });
  const frames = await readFrames(await app.request("/events", { headers: { "last-event-id": cursor } }), 2);
  const [resumed] = await readFrames(await app.request("/events", { headers: { "last-event-id": frames[0]!.id } }), 1);
  expect({ frames: frames.map((frame) => [frame.event, frame.data.replay]), resumed: resumed?.id === frames[1]?.id })
    .toEqual({ frames: [["invalidate", true], ["run_event", true]], resumed: true });
});

test("a rolled-back mutation leaves no operator event", async () => {
  const before = await authority.db.selectFrom("authority.operator_event").select("id").where("run_key", "=", "rolled-back").execute();
  await expect(authority.db.transaction().execute(async (trx) => {
    await announce(trx, "rolled-back", { kind: "invalidate", data: { target: "runs", run_id: null } });
    throw new Error("abort mutation");
  })).rejects.toThrow("abort mutation");
  const after = await authority.db.selectFrom("authority.operator_event").select("id").where("run_key", "=", "rolled-back").execute();
  expect([before.length, after.length]).toEqual([0, 0]);
});

test("reconnect marks committed backlog as replay despite an older open transaction", async () => {
  await announce(authority.db, "baseline", { kind: "invalidate", data: { target: "definitions", run_id: null } });
  const baseline = await authority.db.selectFrom("authority.operator_event").select(["id", "commit_txid"]).where("run_key", "=", "baseline").executeTakeFirstOrThrow();
  const holder = openDatabase(authority.url);
  let signal_inserted: () => void = () => undefined;
  let release_transaction: () => void = () => undefined;
  const inserted = new Promise<void>((resolve) => { signal_inserted = resolve; });
  const held = new Promise<void>((resolve) => { release_transaction = resolve; });
  const transaction = holder.transaction().execute(async (trx) => {
    await announce(trx, "older", { kind: "invalidate", data: { target: "runs", run_id: null } });
    signal_inserted();
    await held;
  });
  await inserted;
  const cursor = Buffer.from(JSON.stringify({ id: baseline.id, commit_txid: String(baseline.commit_txid) })).toString("base64url");
  try {
    await announce(authority.db, "newer", { kind: "invalidate", data: { target: "projects", run_id: null } });
    const response = await app.request("/events", { headers: { "last-event-id": cursor } });
    const reader = response.body!.getReader();
    try {
      const ready = new TextDecoder().decode((await reader.read()).value);
      release_transaction();
      await transaction;
      const frames = await readFramesFromReader(reader, 2);
      expect({ ready: ready.includes(": ready"), frames: frames.map((frame) => [frame.data.target, frame.data.replay]) })
        .toEqual({ ready: true, frames: [["runs", false], ["projects", true]] });
    } finally { await reader.cancel(); }
  } finally { release_transaction(); await transaction; await holder.destroy(); }
});

const cursorAt = (commit_txid: string): string => Buffer.from(JSON.stringify({ id: "e", commit_txid })).toString("base64url");
test("a cursor past the bigint range is refused, and one at its edge streams", async () => {
  const beyond = (await app.request("/events", { headers: { "last-event-id": cursorAt("9223372036854775808") } })).status;
  const edge = await app.request("/events", { headers: { "last-event-id": cursorAt("9223372036854775807") } });
  const reader = edge.body!.getReader();
  await reader.read();
  const after_polls = await Promise.race([reader.read().then((chunk) => chunk.done ? "closed" : "frame"), Bun.sleep(300).then(() => "open")]);
  await reader.cancel();
  expect({ beyond, edge: edge.status, after_polls }).toEqual({ beyond: 400, edge: 200, after_polls: "open" });
});
