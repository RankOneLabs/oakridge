import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import type { SessionId } from "../../session/session";
import { inboxHandler, type InboxStreamManager } from "../../stream/inbox";
import { streamForSession, type SessionStreamSource } from "../../stream/sse";

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (buf: string) => boolean,
  timeoutMs = 1000,
): Promise<string> {
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutResult = new Promise<{ done: true; value: undefined }>((r) => {
      timeout = setTimeout(() => r({ done: true, value: undefined }), remaining);
    });
    const result = await Promise.race([reader.read(), timeoutResult]).finally(() => {
      if (timeout !== undefined) clearTimeout(timeout);
    });
    if (result.done) break;
    buf += decoder.decode(result.value, { stream: true });
    if (predicate(buf)) return buf;
  }
  throw new Error(`readUntil timed out. Buffered: ${JSON.stringify(buf)}`);
}

describe("SSE readiness", () => {
  test("inbox stream writes ready before the snapshot frame", async () => {
    const app = new Hono();
    const manager = {
      subscribeInbox: () => () => {},
      listSnapshots: () => [],
    } satisfies InboxStreamManager;
    const controller = new AbortController();

    app.get("/inbox", inboxHandler(manager));

    const res = await app.fetch(
      new Request("http://kbbl.test/inbox", { signal: controller.signal }),
    );

    expect(res.status).toBe(200);
    expect(res.body).not.toBeNull();

    const reader = res.body!.getReader();
    try {
      const buf = await readUntil(reader, (b) => b.includes("event: snapshot"));
      expect(buf.indexOf(": ready")).toBeGreaterThanOrEqual(0);
      expect(buf.indexOf(": ready")).toBeLessThan(buf.indexOf("event: snapshot"));
    } finally {
      controller.abort();
      await reader.cancel().catch(() => {});
    }
  });

  test("session stream awaits flushTranscript before reading JSONL replay", async () => {
    const app = new Hono();
    const endedController = new AbortController();
    const order: string[] = [];
    let resolveFlush: () => void = () => {};
    let resolveHistory: (contents: string) => void = () => {};
    const flushPromise = new Promise<void>((r) => { resolveFlush = r; });
    const historyPromise = new Promise<string>((r) => { resolveHistory = r; });
    const session = {
      oakridgeSid: "sid-flush" as SessionId,
      endedSignal: endedController.signal,
      subscribe: () => () => {},
      flushTranscript: () => {
        order.push("flush");
        return flushPromise;
      },
      readJsonl: () => {
        order.push("read");
        return historyPromise;
      },
    } satisfies SessionStreamSource;
    const controller = new AbortController();

    app.get("/sessions/:sid/stream", (c) => streamForSession(session, c));

    const res = await app.fetch(
      new Request("http://kbbl.test/sessions/sid-flush/stream", {
        signal: controller.signal,
      }),
    );
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    try {
      // Wait for the ready comment — flush hasn't resolved yet so readJsonl
      // must not have been called.
      await readUntil(reader, (b) => b.includes(": ready"));
      // flush is called but not yet resolved; read must not have been called
      expect(order).toEqual(["flush"]);

      // Now resolve the flush — readJsonl should be called next.
      resolveFlush();
      await new Promise((r) => setTimeout(r, 50));
      expect(order).toEqual(["flush", "read"]);
    } finally {
      resolveHistory("");
      endedController.abort();
      controller.abort();
      await reader.cancel().catch(() => {});
    }
  });

  test("session stream with no flushTranscript still replays history", async () => {
    const app = new Hono();
    const endedController = new AbortController();
    let resolveHistory: (contents: string) => void = () => {};
    const history = new Promise<string>((resolve) => {
      resolveHistory = resolve;
    });
    const session = {
      oakridgeSid: "sid-noflush" as SessionId,
      endedSignal: endedController.signal,
      subscribe: () => () => {},
      readJsonl: () => history,
    } satisfies SessionStreamSource;
    const controller = new AbortController();

    app.get("/sessions/:sid/stream2", (c) => streamForSession(session, c));

    const res = await app.fetch(
      new Request("http://kbbl.test/sessions/sid-noflush/stream2", {
        signal: controller.signal,
      }),
    );
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    try {
      await readUntil(reader, (b) => b.includes(": ready"));
    } finally {
      resolveHistory("");
      endedController.abort();
      controller.abort();
      await reader.cancel().catch(() => {});
    }
  });

  test("session stream writes ready before reading replay history", async () => {
    const app = new Hono();
    const endedController = new AbortController();
    let resolveHistory: (contents: string) => void = () => {};
    const history = new Promise<string>((resolve) => {
      resolveHistory = resolve;
    });
    const session = {
      oakridgeSid: "sid-ready" as SessionId,
      endedSignal: endedController.signal,
      subscribe: () => () => {},
      readJsonl: () => history,
    } satisfies SessionStreamSource;
    const controller = new AbortController();

    app.get("/sessions/:sid/stream", (c) => streamForSession(session, c));

    const res = await app.fetch(
      new Request("http://kbbl.test/sessions/sid-ready/stream", {
        signal: controller.signal,
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).not.toBeNull();

    const reader = res.body!.getReader();
    try {
      const buf = await readUntil(reader, (b) => b.includes(": ready"));
      expect(buf).toContain(": ready");
    } finally {
      resolveHistory("");
      endedController.abort();
      controller.abort();
      await reader.cancel().catch(() => {});
    }
  });
});
