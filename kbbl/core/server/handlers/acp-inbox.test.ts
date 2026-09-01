// GET /inbox over the ACP session list: authoritative snapshot on
// connect, a fresh snapshot after session changes, PWA wire shape.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

import { makeAcpTestService, type AcpTestHarness } from "../../acp/test-harness";
import type { PwaSessionSnapshot } from "../../acp/pwa-wire";
import { acpInboxHandler, listPwaSessions } from "./acp-inbox";

let tmpRoot: string | null = null;
let harness: AcpTestHarness | null = null;

afterEach(async () => {
  await harness?.service.shutdown();
  harness = null;
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = null;
});

function makeHarness(): AcpTestHarness {
  tmpRoot = mkdtempSync(join(tmpdir(), "acp-inbox-"));
  harness = makeAcpTestService({ stateDir: join(tmpRoot, "state") });
  return harness;
}

interface SnapshotFrame {
  sessions: PwaSessionSnapshot[];
}

/** Reads SSE frames until a `snapshot` event satisfying `predicate`. */
async function readSnapshotUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (frame: SnapshotFrame) => boolean,
  timeoutMs = 5000,
): Promise<SnapshotFrame> {
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutResult = new Promise<{ done: true; value: undefined }>((r) => {
      timeout = setTimeout(() => r({ done: true, value: undefined }), remaining);
    });
    const result = await Promise.race([reader.read(), timeoutResult]).finally(
      () => {
        if (timeout !== undefined) clearTimeout(timeout);
      },
    );
    if (result.done) break;
    buf += decoder.decode(result.value, { stream: true });
    for (const block of buf.split("\n\n")) {
      if (!block.includes("event: snapshot")) continue;
      const dataLine = block
        .split("\n")
        .find((line) => line.startsWith("data: "));
      if (!dataLine) continue;
      const frame = JSON.parse(dataLine.slice("data: ".length)) as SnapshotFrame;
      if (predicate(frame)) return frame;
    }
  }
  throw new Error(`no matching snapshot frame. Buffered: ${JSON.stringify(buf)}`);
}

describe("GET /inbox (ACP)", () => {
  test("writes ready before the first snapshot frame", async () => {
    // Without an early `: ready` write the EventSource sits on an empty
    // body until the heartbeat and the browser spinner never settles.
    const h = makeHarness();
    const app = new Hono();
    app.get("/inbox", acpInboxHandler(h.service));
    const controller = new AbortController();
    const res = await app.fetch(
      new Request("http://kbbl.test/inbox", { signal: controller.signal }),
    );
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      const deadline = Date.now() + 5000;
      while (!buf.includes("event: snapshot") && Date.now() < deadline) {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const timeoutResult = new Promise<{ done: true; value: undefined }>(
          (r) => {
            timeout = setTimeout(
              () => r({ done: true, value: undefined }),
              deadline - Date.now(),
            );
          },
        );
        const result = await Promise.race([reader.read(), timeoutResult]).finally(
          () => {
            if (timeout !== undefined) clearTimeout(timeout);
          },
        );
        if (result.done) break;
        buf += decoder.decode(result.value, { stream: true });
      }
      expect(buf.indexOf(": ready")).toBeGreaterThanOrEqual(0);
      expect(buf.indexOf(": ready")).toBeLessThan(buf.indexOf("event: snapshot"));
    } finally {
      controller.abort();
      await reader.cancel().catch(() => {});
    }
  }, 15000);

  test("connect delivers the current session list in the PWA wire shape", async () => {
    const h = makeHarness();
    const created = await h.service.createSession({
      initial_prompt: "",
      workdir: tmpRoot!,
      runtime: "claude-code",
      name: "inbox-one",
    });
    expect(created.ok).toBe(true);

    const app = new Hono();
    app.get("/inbox", acpInboxHandler(h.service));
    const controller = new AbortController();
    const res = await app.fetch(
      new Request("http://kbbl.test/inbox", { signal: controller.signal }),
    );
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    try {
      const frame = await readSnapshotUntil(reader, (f) => f.sessions.length === 1);
      const snapshot = frame.sessions[0]!;
      expect(snapshot.name).toBe("inbox-one");
      expect(snapshot.agentProfile).toBe("claude-code");
      expect(snapshot.source).toBe("acp");
      expect(snapshot.status).toBe("idle");
      expect(snapshot.pendingPermissionCount).toBe(0);
      expect("acp_session_id" in snapshot).toBe(false);
    } finally {
      controller.abort();
      await reader.cancel().catch(() => {});
    }
  }, 15000);

  test("a session change pushes a fresh snapshot to a connected client", async () => {
    const h = makeHarness();
    const app = new Hono();
    app.get("/inbox", acpInboxHandler(h.service));
    const controller = new AbortController();
    const res = await app.fetch(
      new Request("http://kbbl.test/inbox", { signal: controller.signal }),
    );
    const reader = res.body!.getReader();
    try {
      await readSnapshotUntil(reader, (f) => f.sessions.length === 0);
      const created = await h.service.createSession({
        initial_prompt: "",
        workdir: tmpRoot!,
        runtime: "claude-code",
        name: "late-arrival",
      });
      expect(created.ok).toBe(true);
      const frame = await readSnapshotUntil(
        reader,
        (f) => f.sessions.length === 1,
      );
      expect(frame.sessions[0]!.name).toBe("late-arrival");

      if (created.ok) await h.service.closeSession(created.value.sid);
      const closedFrame = await readSnapshotUntil(
        reader,
        (f) => f.sessions[0]?.status === "ended",
      );
      expect(closedFrame.sessions[0]!.endReason).toBe("user_closed");
    } finally {
      controller.abort();
      await reader.cancel().catch(() => {});
    }
  }, 15000);

  test("listPwaSessions orders newest activity first", async () => {
    const h = makeHarness();
    const first = await h.service.createSession({
      initial_prompt: "",
      workdir: tmpRoot!,
      runtime: "claude-code",
      name: "older",
    });
    expect(first.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    const second = await h.service.createSession({
      initial_prompt: "",
      workdir: tmpRoot!,
      runtime: "claude-code",
      name: "newer",
    });
    expect(second.ok).toBe(true);

    const listed = listPwaSessions(h.service);
    expect(listed.map((s) => s.name)).toEqual(["newer", "older"]);
  }, 15000);
});
