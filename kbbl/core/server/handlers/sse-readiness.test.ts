import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import type { Session } from "../../session/session";
import type { SessionManager } from "../../session/session-manager";
import { inboxHandler } from "../../stream/inbox";
import { streamForSession } from "../../stream/sse";

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
    const result = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((r) =>
        setTimeout(() => r({ done: true, value: undefined }), remaining),
      ),
    ]);
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
    } as unknown as SessionManager;
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

  test("session stream writes ready before reading replay history", async () => {
    const app = new Hono();
    const endedController = new AbortController();
    let resolveHistory: (contents: string) => void = () => {};
    const history = new Promise<string>((resolve) => {
      resolveHistory = resolve;
    });
    const session = {
      oakridgeSid: "sid-ready",
      endedSignal: endedController.signal,
      subscribe: () => () => {},
      readJsonl: () => history,
    } as unknown as Session;
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
