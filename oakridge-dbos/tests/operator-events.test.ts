import { expect, test } from "bun:test";
import { Hono } from "hono";
import { withDatabase } from "./effect-fixture";
import { developmentBundle, runtimeFixture, brief, repository } from "./development-runtime-fixture";
import { installEventStream } from "../src/http/events";
import type { RunEvent } from "../src/projections/run-event";
import { writeOperatorEvent } from "../src/storage/operator-events";
import { deleteRun } from "../src/storage/mutation-service";

test("rolling back a run mutation also removes its operator event", async () => withDatabase(async ({ db }) => {
  const f = await runtimeFixture(db, await developmentBundle(), { brief, repository });
  try {
    const before = (await db.query<{ count: string }>("SELECT count(*)::text AS count FROM authority.operator_event WHERE run_key=$1", [f.run_id]))[0]!.count;
    await expect(db.transaction(async (tx) => {
      await tx.query("UPDATE authority.run SET archived_at=now() WHERE id=$1", [f.run_id]);
      await writeOperatorEvent(tx, f.run_id, f.run_id, { kind: "invalidate", data: { target: "runs", run_id: f.run_id } });
      throw new Error("abort mutation");
    })).rejects.toThrow("abort mutation");
    expect((await db.query<{ count: string }>("SELECT count(*)::text AS count FROM authority.operator_event WHERE run_key=$1", [f.run_id]))[0]!.count).toBe(before);
    expect((await db.query<{ archived_at: string | null }>("SELECT archived_at FROM authority.run WHERE id=$1", [f.run_id]))[0]!.archived_at).toBeNull();
  } finally { f.core.close(); }
}));

test("deleting a run leaves a durable invalidate row with its run key", async () => withDatabase(async ({ db }) => {
  const f = await runtimeFixture(db, await developmentBundle(), { brief, repository });
  try {
    expect(await deleteRun(db, f.run_id)).toMatchObject({ kind: "deleted" });
    const rows = await db.query<{ run_id: string | null; event_key: string; payload: { kind: string; data: { run_id: string } } }>(
      "SELECT run_id,event_key,payload FROM authority.operator_event WHERE run_key=$1 ORDER BY commit_txid,id", [f.run_id]);
    expect(rows.some((row) => row.run_id === null && row.event_key === "invalidate" && row.payload.data.run_id === f.run_id)).toBe(true);
  } finally { f.core.close(); }
}));

interface Frame { readonly id: string; readonly event: RunEvent }
interface RawFrame { readonly id: string; readonly event: string; readonly data: { readonly replay: boolean; readonly [key: string]: unknown } }
/** Reads SSE frames from an already subscribed stream. */
async function readAnyFramesFromReader(reader: ReadableStreamDefaultReader<Uint8Array>, count: number): Promise<readonly RawFrame[]> {
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
async function readAnyFrames(response: Response, count: number): Promise<readonly RawFrame[]> {
  const reader = response.body!.getReader();
  try { return await readAnyFramesFromReader(reader, count); }
  finally { await reader.cancel(); }
}
async function readFrames(response: Response, count: number): Promise<readonly Frame[]> {
  const frames = await readAnyFrames(response, count);
  return frames.filter((frame) => frame.event === "run_event").map((frame) => ({ id: frame.id, event: frame.data as unknown as RunEvent }));
}

test("the event stream delivers transitions committed after subscribing and resumes from a frame's id", async () => withDatabase(async ({ db }) => {
  const f = await runtimeFixture(db, await developmentBundle(), { brief, repository });
  const app = new Hono();
  installEventStream(app, { db, timing: { poll_ms: 20, heartbeat_ms: 1_000 } });
  try {
    const live = await app.request("/events");
    expect(live.headers.get("content-type")).toContain("text/event-stream");
    await Bun.sleep(50); // the subscriber starts from now
    await f.fact("begin");
    const [first] = await readFrames(live, 1);
    expect(first!.event).toMatchObject({ run_id: f.run_id, scope_id: f.root_scope_id, scope_key: "implementation", decision: "apply", is_terminal: false });
    expect(first!.event).toHaveProperty("replay", false);
    const fresh = await app.request("/events");
    await Bun.sleep(50); // subscribed after `begin` committed, so it must not replay it
    await f.command("cancel");
    const [cancelled] = await readFrames(fresh, 1);
    expect(cancelled!.event).toMatchObject({ run_id: f.run_id, decision: "apply", is_terminal: true });
    const resumed = await readFrames(await app.request("/events", { headers: { "last-event-id": first!.id } }), 1);
    expect(resumed[0]!.event.transition_id).toBe(cancelled!.event.transition_id);
    expect((await app.request("/events", { headers: { "last-event-id": "not-a-cursor" } })).status).toBe(400);
  } finally { f.core.close(); }
}));

test("one Last-Event-ID replays invalidate and run_event frames in order", async () => withDatabase(async ({ db }) => {
  const f = await runtimeFixture(db, await developmentBundle(), { brief, repository });
  const app = new Hono();
  installEventStream(app, { db, timing: { poll_ms: 20, heartbeat_ms: 1_000 } });
  try {
    const launch = (await db.query<{ id: string; commit_txid: string }>(
      "SELECT id,commit_txid::text AS commit_txid FROM authority.operator_event ORDER BY commit_txid DESC,id DESC LIMIT 1", []))[0]!;
    const cursor = Buffer.from(JSON.stringify(launch)).toString("base64url");
    expect(await f.mutations.setRunArchived(f.run_id, true)).toBe(true);
    await f.fact("begin");
    const frames = await readAnyFrames(await app.request("/events", { headers: { "last-event-id": cursor } }), 2);
    expect(frames.map((frame) => [frame.event, frame.data.replay])).toEqual([["invalidate", true], ["run_event", true]]);
    expect(new Set(frames.map((frame) => frame.id)).size).toBe(2);
    const resumed = await readAnyFrames(await app.request("/events", { headers: { "last-event-id": frames[0]!.id } }), 1);
    expect(resumed[0]!.id).toBe(frames[1]!.id);
  } finally { f.core.close(); }
}));

test("reconnect marks committed backlog as replay despite an older open transaction", async () => withDatabase(async ({ db }) => {
  await writeOperatorEvent(db, null, "baseline", { kind: "invalidate", data: { target: "definitions", run_id: null } });
  const baseline = (await db.query<{ id: string; commit_txid: string }>(
    "SELECT id,commit_txid::text AS commit_txid FROM authority.operator_event WHERE run_key='baseline'", []))[0]!;
  let signal_inserted: () => void = () => undefined;
  let release_transaction: () => void = () => undefined;
  const inserted = new Promise<void>((resolve) => { signal_inserted = resolve; });
  const held = new Promise<void>((resolve) => { release_transaction = resolve; });
  const transaction = db.transaction(async (tx) => {
    await writeOperatorEvent(tx, null, "older", { kind: "invalidate", data: { target: "runs", run_id: null } });
    signal_inserted();
    await held;
  });
  await inserted;
  const app = new Hono();
  installEventStream(app, { db, timing: { poll_ms: 20, heartbeat_ms: 1_000 } });
  const cursor = Buffer.from(JSON.stringify(baseline)).toString("base64url");
  try {
    await writeOperatorEvent(db, null, "newer", { kind: "invalidate", data: { target: "projects", run_id: null } });
    const response = await app.request("/events", { headers: { "last-event-id": cursor } });
    const reader = response.body!.getReader();
    try {
      expect(new TextDecoder().decode((await reader.read()).value)).toContain(": ready");
      release_transaction();
      await transaction;
      const frames = await readAnyFramesFromReader(reader, 2);
      expect(frames.map((frame) => [frame.data.target, frame.data.replay])).toEqual([["runs", false], ["projects", true]]);
    } finally { await reader.cancel(); }
  } finally { release_transaction(); await transaction; }
}));
