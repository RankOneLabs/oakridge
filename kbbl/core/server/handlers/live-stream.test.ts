import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { mkdtempSync, rmSync } from "node:fs";
import { makeAcpTestService } from "../../acp/test-harness";
import { mountAcpPerSidRoutes } from "./acp-per-sid";

import { createSseDecoderState, decodeSseChunk, type LiveStreamFrame, type LiveStreamTopic } from "../../live-stream";
import { mountLiveStreamRoutes } from "./live-stream";

const SID = "aaaaaaaa-bbbb-4ccc-8ddd-000000000001";
const topics: LiveStreamTopic[] = ["/inbox", "/oakridge/api/events", `/sessions/${SID}/stream`];
const liveUrl = `/live?${new URLSearchParams(topics.map((topic) => ["topic", topic]))}`;

interface StreamRead {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  frames: LiveStreamFrame[];
}

async function readFrames(response: Response, count: number): Promise<StreamRead> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("missing SSE response body");
  const decoder = new TextDecoder();
  let state = createSseDecoderState();
  const frames: LiveStreamFrame[] = [];
  while (frames.length < count) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("stream ended before expected frames");
    const decoded = decodeSseChunk(state, decoder.decode(chunk.value, { stream: true }));
    state = decoded.state;
    frames.push(...decoded.frames.map((frame) => JSON.parse(frame.data) as LiveStreamFrame));
  }
  return { reader, frames };
}

describe("combined live stream", () => {
  test("rejects arbitrary routes and invalid session ids before opening any source", async () => {
    const app = new Hono();
    mountLiveStreamRoutes(app);
    const responses = await Promise.all(["/config", "/live", "/sessions/../stream"].map((topic) => app.request(`/live?topic=${encodeURIComponent(topic)}`)));
    expect(responses.map((response) => response.status)).toEqual([400, 400, 400]);
  });

  test("two page feeds preserve channel events and allow input while streaming, then release every source", async () => {
    const app = new Hono();
    let activeSources = 0;
    for (const topic of topics) {
      app.get(topic, (c) => streamSSE(c, async (stream) => {
        activeSources++;
        let finish: (() => void) | null = null;
        const done = new Promise<void>((resolve) => { finish = resolve; });
        stream.onAbort(() => finish?.());
        try {
          await stream.write(": ready\n\n");
          await stream.writeSSE({ event: topic === "/inbox" ? "snapshot" : topic === "/oakridge/api/events" ? "run_event" : "epoch", data: JSON.stringify({ topic }), id: "7" });
          if (topic.startsWith("/sessions/")) await stream.writeSSE({ event: "acp", data: JSON.stringify({ kind: "user_message", text: "replayed history" }) });
          await done;
        } finally { activeSources--; }
      }));
    }
    app.post(`/sessions/${SID}/input`, (c) => c.json({ status: "accepted" }));
    mountLiveStreamRoutes(app);
    const controllers = [new AbortController(), new AbortController()];
    const reads = await Promise.all(controllers.map(async (controller) => readFrames(await app.request(liveUrl, { signal: controller.signal }), 4)));
    try {
      const receipts = await Promise.all(controllers.map(async () => (await app.request(`/sessions/${SID}/input`, { method: "POST" })).json()));
      expect({ channels: reads.map(({ frames }) => frames.map(({ topic, frame }) => [topic, frame.event]).sort()), receipts, activeSources }).toEqual({
        channels: controllers.map(() => [["/inbox", "snapshot"], ["/oakridge/api/events", "run_event"], [`/sessions/${SID}/stream`, "epoch"], [`/sessions/${SID}/stream`, "acp"]].sort()),
        receipts: [{ status: "accepted" }, { status: "accepted" }], activeSources: 6,
      });
    } finally {
      controllers.forEach((controller) => controller.abort());
      await Promise.all(reads.map(({ reader }) => reader.cancel()));
    }
    await Bun.sleep(10);
    expect(activeSources).toBe(0);
  });

  test("an unavailable session reports its error while the inbox remains readable", async () => {
    const app = new Hono();
    app.get(`/sessions/${SID}/stream`, (c) => c.json({ error: "unknown session" }, 404));
    app.get("/inbox", (c) => streamSSE(c, async (stream) => {
      await stream.write(": ready\n\n");
      await stream.writeSSE({ event: "snapshot", data: '{"sessions":[]}' });
      await new Promise<void>((resolve) => stream.onAbort(resolve));
    }));
    mountLiveStreamRoutes(app);
    const controller = new AbortController();
    const response = await app.request(`/live?${new URLSearchParams(topics.filter((topic) => topic !== "/oakridge/api/events").map((topic) => ["topic", topic]))}`, { signal: controller.signal });
    const { reader, frames } = await readFrames(response, 2);
    controller.abort();
    await reader.cancel();
    expect(frames.map(({ frame }) => frame.event).sort()).toEqual(["snapshot", "stream_error"]);
  });

  test("a failed run-event source recovers without replaying the healthy inbox", async () => {
    const app = new Hono();
    let inboxSubscriptions = 0;
    let runSubscriptions = 0;
    app.get("/inbox", (c) => streamSSE(c, async (stream) => {
      inboxSubscriptions++;
      await stream.write(": ready\n\n");
      await stream.writeSSE({ event: "snapshot", data: '{"sessions":[]}' });
      await new Promise<void>((resolve) => stream.onAbort(resolve));
    }));
    app.get("/oakridge/api/events", (c) => {
      runSubscriptions++;
      if (runSubscriptions === 1) return c.json({ error: "backend restarting" }, 503);
      return streamSSE(c, async (stream) => {
        await stream.write(": ready\n\n");
        await stream.writeSSE({ event: "invalidate", data: "{}" });
        await new Promise<void>((resolve) => stream.onAbort(resolve));
      });
    });
    mountLiveStreamRoutes(app);
    const controller = new AbortController();
    const url = `/live?${new URLSearchParams(topics.slice(0, 2).map((topic) => ["topic", topic]))}`;
    const { reader, frames } = await readFrames(await app.request(url, { signal: controller.signal }), 3);
    controller.abort();
    await reader.cancel();
    expect({ inboxSubscriptions, runSubscriptions, events: frames.map(({ frame }) => frame.event).sort() }).toEqual({
      inboxSubscriptions: 1, runSubscriptions: 2, events: ["invalidate", "snapshot", "stream_error"],
    });
  });

  test("closing the combined feed during cold session replay releases the loading agent", async () => {
    const root = mkdtempSync("/tmp/kbbl-live-cold-");
    const first = makeAcpTestService({ stateDir: root });
    const cold = makeAcpTestService({ stateDir: root, db: first.db, behavior: "delayed_load", delayMs: 600 });
    try {
      const created = await first.service.createSession({ initial_prompt: "remember this", workdir: root, runtime: "fake" });
      if (!created.ok) throw new Error(created.error.detail);
      await first.service.observeInitialTurn(created.value.sid, 8000);
      await first.service.shutdown();
      const app = new Hono();
      mountAcpPerSidRoutes(app, { acp: cold.service });
      mountLiveStreamRoutes(app);
      const controller = new AbortController();
      const url = `/live?topic=${encodeURIComponent(`/sessions/${created.value.sid}/stream`)}`;
      const response = await app.request(url, { signal: controller.signal });
      const reader = response.body?.getReader();
      if (!reader) throw new Error("missing response body");
      await reader.read(); // early readiness, before the agent finishes loading
      controller.abort();
      await reader.cancel();
      await Bun.sleep(800);
      expect(cold.registry.liveCount()).toBe(0);
    } finally {
      await first.service.shutdown();
      await cold.service.shutdown();
      first.db.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15000);
});

test("SSE chunk decoding preserves multiline data, frame ids and split CRLF", () => {
  const first = decodeSseChunk(createSseDecoderState(), ': ready\r\nevent: epoch\r\nid: 7\r\ndata: first\r');
  const second = decodeSseChunk(first.state, '\ndata: second\r\n\r\nevent: acp\ndata: next\n\n');
  expect(second.frames).toEqual([{ event: "epoch", id: "7", data: "first\nsecond" }, { event: "acp", id: "7", data: "next" }]);
});
