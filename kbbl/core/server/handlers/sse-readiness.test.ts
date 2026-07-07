import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import type { EnvelopeEvent, SessionId } from "../../session/session";
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

      // Now resolve the flush — readJsonl should be called next. Poll until
      // the observable condition is met rather than sleeping a fixed interval,
      // which is flaky under load.
      resolveFlush();
      const deadline = Date.now() + 1000;
      while (order.length < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
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

  test("session stream replays event made durable by immediate flush", async () => {
    const app = new Hono();
    const endedController = new AbortController();
    const persisted = {
      id: 1,
      type: "session_started",
      ts: "2026-01-01T00:00:00.000Z",
      payload: { phase: "persisted" },
    } satisfies EnvelopeEvent;
    const buffered = {
      id: 2,
      type: "assistant_delta",
      ts: "2026-01-01T00:00:00.001Z",
      payload: { text: "buffered" },
    } satisfies EnvelopeEvent;
    let contents = `${JSON.stringify(persisted)}\n`;
    const session = {
      oakridgeSid: "sid-buffered" as SessionId,
      endedSignal: endedController.signal,
      subscribe: () => () => {},
      flushTranscript: async () => {
        contents += `${JSON.stringify(buffered)}\n`;
      },
      readJsonl: async () => contents,
    } satisfies SessionStreamSource;
    const controller = new AbortController();

    app.get("/sessions/:sid/stream-buffered", (c) =>
      streamForSession(session, c),
    );

    const res = await app.fetch(
      new Request("http://kbbl.test/sessions/sid-buffered/stream-buffered", {
        signal: controller.signal,
      }),
    );
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    try {
      const buf = await readUntil(reader, (b) => b.includes("id: 2"));
      expect(buf).toContain("id: 1");
      expect(buf).toContain("id: 2");
      expect(buf).toContain("buffered");
    } finally {
      endedController.abort();
      controller.abort();
      await reader.cancel().catch(() => {});
    }
  });

  test("Last-Event-Id replay flushes before filtering missed events", async () => {
    const app = new Hono();
    const endedController = new AbortController();
    const alreadySeen = {
      id: 7,
      type: "assistant_delta",
      ts: "2026-01-01T00:00:00.000Z",
      payload: { text: "seen" },
    } satisfies EnvelopeEvent;
    const missed = {
      id: 8,
      type: "assistant_delta",
      ts: "2026-01-01T00:00:00.001Z",
      payload: { text: "missed buffered" },
    } satisfies EnvelopeEvent;
    let contents = `${JSON.stringify(alreadySeen)}\n`;
    const session = {
      oakridgeSid: "sid-resume-buffered" as SessionId,
      endedSignal: endedController.signal,
      subscribe: () => () => {},
      flushTranscript: async () => {
        contents += `${JSON.stringify(missed)}\n`;
      },
      readJsonl: async () => contents,
    } satisfies SessionStreamSource;
    const controller = new AbortController();

    app.get("/sessions/:sid/stream-resume", (c) =>
      streamForSession(session, c),
    );

    const res = await app.fetch(
      new Request("http://kbbl.test/sessions/sid-resume-buffered/stream-resume", {
        headers: { "Last-Event-Id": "7" },
        signal: controller.signal,
      }),
    );
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    try {
      const buf = await readUntil(reader, (b) => b.includes("id: 8"));
      expect(buf).not.toContain("id: 7");
      expect(buf).toContain("id: 8");
      expect(buf).toContain("missed buffered");
    } finally {
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
