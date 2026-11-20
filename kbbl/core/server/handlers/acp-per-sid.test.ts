// Request validation for the §14 browser routes. Semantics (idempotency,
// busy, permissions) are covered at the service level and through the
// DBOS contract suite; these tests pin the HTTP validation surface.

import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { SSEStreamingApi } from "hono/streaming";

import { toWireFrames, type SessionEpochFrame, type SessionWireFrame } from "../../acp/session-wire";
import { transcriptItemId, transcriptSeq, type TranscriptItem } from "../../acp/transcript-model";
import type { ItemPage } from "../../acp/transcript-page";

import { makeAcpTestService } from "../../acp/test-harness";
import { mountAcpPerSidRoutes } from "./acp-per-sid";

const tmpRoot = mkdtempSync(join(tmpdir(), "acp-per-sid-"));
const harness = makeAcpTestService({ stateDir: join(tmpRoot, "state") });
const app = new Hono();
mountAcpPerSidRoutes(app, { acp: harness.service });

afterAll(async () => {
  await harness.service.shutdown();
  rmSync(tmpRoot, { recursive: true, force: true });
});

const SID = "aaaaaaaa-bbbb-4ccc-8ddd-000000000001";

async function postInput(body: unknown): Promise<Response> {
  return app.request(`/sessions/${SID}/input`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /sessions/:sid/input validation", () => {
  test("an empty client_message_id is rejected, not collapsed onto a shared turn key", async () => {
    const res = await postInput({ text: "hello", client_message_id: "" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("client_message_id");
  });

  test("a non-string client_message_id is rejected", async () => {
    const res = await postInput({ text: "hello", client_message_id: 7 });
    expect(res.status).toBe(400);
  });

  test("empty text is rejected", async () => {
    const res = await postInput({ text: "   " });
    expect(res.status).toBe(400);
  });

  test("a valid body for an unknown session reaches the service and 404s", async () => {
    const res = await postInput({ text: "hello", client_message_id: "msg-1" });
    expect(res.status).toBe(404);
  });
});

test("cold session stream flushes readiness and releases its child after disconnect", async () => {
  const stateDir = join(tmpRoot, "cold-stream-state");
  const first = makeAcpTestService({ stateDir });
  const created = await first.service.createSession({
    initial_prompt: "remember this",
    workdir: tmpRoot,
    runtime: "fake",
  });
  if (!created.ok) throw new Error(`create failed: ${created.error.code}`);
  const sid = created.value.sid;
  await first.service.observeInitialTurn(sid, 8000);
  await first.service.shutdown();

  const cold = makeAcpTestService({
    stateDir,
    db: first.db,
    behavior: "delayed_load",
    delayMs: 600,
  });
  const coldApp = new Hono();
  mountAcpPerSidRoutes(coldApp, { acp: cold.service });
  const requestController = new AbortController();
  const response = await coldApp.fetch(
    new Request(`http://kbbl.test/sessions/${sid}/stream`, {
      signal: requestController.signal,
    }),
  );
  const reader = response.body?.getReader();
  if (!reader) throw new Error("stream response has no body");

  try {
    const firstChunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("readiness frame timed out")), 250),
      ),
    ]);
    expect(new TextDecoder().decode(firstChunk.value)).toContain(": ready");
  } finally {
    requestController.abort();
    await reader.cancel().catch(() => {});
  }

  // Wait past the fake agent's load delay: a cancelled single-flight must
  // not install a controller after the request has already disappeared.
  await new Promise((resolve) => setTimeout(resolve, 800));
  const deadline = Date.now() + 3000;
  while (cold.registry.liveCount() !== 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(cold.registry.liveCount()).toBe(0);
  const history = await coldApp.request(`/sessions/${sid}/history`);
  expect(history.status).toBe(200);
  const epoch: SessionEpochFrame = await history.json();
  expect(epoch.kind).toBe("epoch");
  expect(epoch.items.length).toBeGreaterThan(0);
  expect(cold.registry.liveCount()).toBe(0);
  const retained = await coldApp.request(`/sessions/${sid}/items?epoch=${epoch.stream_epoch}&before_seq=100`);
  expect(retained.status).toBe(200);
  expect(await retained.json()).toEqual({ kind: "page", stream_epoch: epoch.stream_epoch, items: epoch.items, has_earlier: false });
  expect(cold.registry.liveCount()).toBe(0);
  await cold.service.shutdown();
}, 15000);

test("usage is public and preserves ordered turns, null usage and cost readings", async () => {
  const sid = crypto.randomUUID() as import("../../acp/types").KbblSessionId;
  harness.store.insertSession({ sid, resumable_key: null, start_spec_hash: null, agent_profile: "fake",
    name: "usage", artifact_id: null, project_workdir: "/tmp", worktree_path: "/tmp",
    requested_model: null, requested_effort: null, requested_mode: null, workflow: null });
  for (const key of ["reported", "absent", "pending"]) {
    const turn_key = key as import("../../acp/types").TurnKey;
    harness.store.acceptTurn({ sid, turn_key, source: "operator", payload: key });
    if (key !== "pending") harness.store.completeTurn(sid, turn_key, { status: "succeeded" },
      key === "reported" ? { status: "reported", input_tokens: 1, output_tokens: 2, cached_read_tokens: 0,
        cached_write_tokens: 0, thought_tokens: 0, total_tokens: 3, model_usage: [], raw_json: "{}" } : { status: "absent" });
  }
  for (const amount of [1, 3]) harness.store.usage.appendReading({
    sid, process_seq: 0, context_used: 20, context_size: 100, cost_amount: amount, cost_currency: "USD",
    active_turn_key: null, autonomous: false, origin_kind: null,
  });
  const response = await app.request(`/sessions/${sid}/usage`);
  expect(response.status).toBe(200);
  const body: import("../../acp/usage-types").SessionUsage = await response.json();
  expect(body.turns.map(t => t.usage?.status ?? null)).toEqual(["reported", "absent", null]);
  expect(body.turns[0]?.usage?.model_usage).toEqual([]);
  expect(body.readings.map(r => [r.seq, r.cost_amount, r.autonomous])).toEqual([[0, 1, false], [1, 3, false]]);
  expect((await app.request(`/sessions/${SID}/usage`)).status).toBe(404);
});

async function openLiveSession(text: string) {
  const created = await harness.service.createSession({ initial_prompt: text, workdir: tmpRoot, runtime: "fake" });
  if (!created.ok) throw new Error(created.error.detail);
  const sid = created.value.sid;
  await harness.service.observeInitialTurn(sid, 8000);
  const controller = harness.registry.getLive(sid);
  if (!controller) throw new Error("missing controller");
  return { sid, controller };
}

test("the stream writes the history epoch first, then each frame folded during its blocked write", async () => {
  const { sid, controller } = await openLiveSession("before snapshot");
  const history = await app.request(`/sessions/${sid}/history`);
  expect(history.status).toBe(200);
  const epoch: SessionEpochFrame = await history.json();
  expect(epoch).toEqual({
    kind: "epoch", stream_epoch: controller.streamEpoch, history_kind: "transcript", expired: false,
    summary: null, open_turns: [], session_state: controller.snapshotTranscript().live_state,
    items: controller.snapshotTranscript().items, has_earlier: false, is_truncated: false,
  });
  expect(epoch.items).toContainEqual(expect.objectContaining({ kind: "user_message", text: "before snapshot" }));

  const entered = Promise.withResolvers<void>();
  const unblock = Promise.withResolvers<void>();
  const writeSSE = SSEStreamingApi.prototype.writeSSE;
  const written: SessionWireFrame[] = [];
  const spy = spyOn(SSEStreamingApi.prototype, "writeSSE").mockImplementation(async function (this: SSEStreamingApi, message) {
    if (message.event === "epoch") {
      entered.resolve();
      await unblock.promise;
    }
    expect(message.id).toBeUndefined();
    const frame = JSON.parse(await message.data) as SessionWireFrame;
    expect(message.event).toBe(frame.kind);
    written.push(frame);
    await writeSSE.call(this, message);
  });

  const expected: SessionWireFrame[] = [];
  const idle = Promise.withResolvers<void>();
  const unsubscribe = controller.subscribe(({ frames }) => {
    expected.push(...toWireFrames(frames, controller.snapshotTranscript().items));
    if (frames.some((frame) => frame.kind === "turn_state" && frame.state === "idle")) idle.resolve();
  });
  const response = await app.request(`/sessions/${sid}/stream`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("missing SSE body");
  try {
    const decoder = new TextDecoder();
    expect(decoder.decode((await reader.read()).value)).toBe(": ready\n\n");
    await entered.promise;

    const sent = await harness.service.sendInput(sid, "while epoch blocked", { client_message_id: "during-epoch" });
    expect(sent.ok).toBe(true);
    await idle.promise;
    expect(expected.length).toBeGreaterThan(0);
    expect(written).toEqual([]);
    unblock.resolve();

    for (const frame of [epoch, ...expected]) {
      const chunk = decoder.decode((await reader.read()).value);
      expect(chunk).toBe(`event: ${frame.kind}\ndata: ${JSON.stringify(frame)}\n\n`);
    }
    expect(written).toEqual([epoch, ...expected]);
    expect(expected).not.toContainEqual(expect.objectContaining({ kind: "item", item: expect.objectContaining({ text: "before snapshot" }) }));
  } finally {
    unblock.resolve();
    unsubscribe();
    await reader.cancel();
    spy.mockRestore();
  }
}, 15000);

test("items endpoint pages a matching epoch and rejects invalid or stale cursors", async () => {
  const { sid, controller } = await openLiveSession("page test");
  const snapshot = controller.snapshotTranscript();
  const items = Array.from({ length: 510 }, (_, index): TranscriptItem => {
    const seq = transcriptSeq(index);
    return { kind: "user_message", seq, id: transcriptItemId(seq), text: String(seq), message_id: null, turn_key: null, is_replayed: true };
  });
  const spy = spyOn(controller, "snapshotTranscript").mockReturnValue({ ...snapshot, items });
  const url = `/sessions/${sid}/items`;
  try {
    const first = await app.request(`${url}?epoch=${snapshot.stream_epoch}&before_seq=500`);
    expect(first.status).toBe(200);
    const page: ItemPage = await first.json();
    expect(page).toEqual({ kind: "page", stream_epoch: snapshot.stream_epoch, items: items.slice(400, 500), has_earlier: true });
    const second = await app.request(`${url}?epoch=${snapshot.stream_epoch}&before_seq=${page.items[0].seq}&limit=500`);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ kind: "page", stream_epoch: snapshot.stream_epoch, items: items.slice(0, 400), has_earlier: false });

    for (const invalid of ["0", "501", "abc"]) {
      const response = await app.request(`${url}?epoch=${snapshot.stream_epoch}&before_seq=500&limit=${invalid}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_limit" });
    }
    const stale = await app.request(`${url}?epoch=stale&before_seq=500`);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ kind: "epoch_changed", stream_epoch: snapshot.stream_epoch });

    const noEpoch = await app.request(`${url}?before_seq=0`);
    expect(noEpoch.status).toBe(400);
    expect(await noEpoch.json()).toMatchObject({ code: "invalid_epoch" });
    for (const cursor of ["", "-1", "1.5"]) {
      const invalid = await app.request(`${url}?epoch=${snapshot.stream_epoch}&before_seq=${cursor}`);
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ code: "invalid_before_seq" });
    }
    expect((await app.request("/sessions/invalid/items?epoch=none&before_seq=0")).status).toBe(400);
    const unknown = await app.request(`/sessions/${SID}/items?epoch=none&before_seq=0`);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ code: "session_not_found" });
  } finally {
    spy.mockRestore();
  }
}, 15000);
