import { expect, test } from "bun:test";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import { guardSseStream, type GuardableSseStream } from "./sse-backpressure";

/** A stream whose client never reads: every write stays pending until the stream is aborted. */
function stalledStream(): GuardableSseStream & { readonly abortCount: () => number } {
  const waiting: (() => void)[] = [];
  let aborts = 0;
  const pending = () => new Promise<void>((resolve) => { waiting.push(resolve); });
  const stream = {
    aborted: false,
    writeSSE: pending,
    write: async () => { await pending(); return stream as never; },
    abort: () => {
      aborts += 1;
      stream.aborted = true;
      for (const release of waiting.splice(0)) release();
    },
    abortCount: () => aborts,
  };
  return stream;
}

test("a client that falls too far behind is cut off", () => {
  const stream = stalledStream();
  const guard = guardSseStream(stream, { max_pending_writes: 3, stall_ms: 60_000 });
  for (let event = 0; event < 4; event++) void guard.send({ event: "acp", data: String(event) });
  expect(stream.abortCount()).toBe(1);
});

test("a client that has read nothing past the stall limit is cut off at the next heartbeat", () => {
  const stream = stalledStream();
  let clock = 0;
  const guard = guardSseStream(stream, { max_pending_writes: 1000, stall_ms: 60_000 }, () => clock);
  void guard.sendRaw(": ping\n\n");
  clock = 60_000;
  guard.checkStall();
  expect(stream.abortCount()).toBe(1);
});

test("a client that keeps reading is never cut off", async () => {
  const stream = { aborted: false, writeSSE: async () => {}, write: async () => stream as never, abort: () => { stream.aborted = true; } };
  let clock = 0;
  const guard = guardSseStream(stream, { max_pending_writes: 3, stall_ms: 60_000 }, () => clock);
  for (let event = 0; event < 10; event++) await guard.send({ event: "acp", data: String(event) });
  clock = 120_000;
  guard.checkStall();
  expect(stream.aborted).toBe(false);
});

test("nothing more is queued once the stream is aborted", async () => {
  const stream = stalledStream();
  const guard = guardSseStream(stream, { max_pending_writes: 1, stall_ms: 60_000 });
  void guard.send({ event: "acp", data: "0" });
  void guard.send({ event: "acp", data: "1" });
  await guard.send({ event: "acp", data: "2" });
  expect(stream.abortCount()).toBe(1);
});

test("on a real stream nobody reads, the cut-off releases the queued writes and runs the stream's cleanup", async () => {
  const app = new Hono();
  let cleanups = 0;
  let settled: Promise<unknown> = Promise.resolve();
  app.get("/stream", (c) => streamSSE(c, async (stream) => {
    stream.onAbort(() => { cleanups += 1; });
    const guard = guardSseStream(stream, { max_pending_writes: 50, stall_ms: 60_000 });
    settled = Promise.all(Array.from({ length: 60 }, (_, event) => guard.send({ event: "acp", data: "x".repeat(1024) + event })));
    await settled;
  }));
  await app.request("/stream");
  await settled;
  expect(cleanups).toBe(1);
});
