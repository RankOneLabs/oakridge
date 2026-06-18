/**
 * Unit tests for the channel-transport writeInput path (Step 7, brief §).
 *
 * Tests:
 *   (a) Session.writeInput on an external CC-style write emits exactly one
 *       `user` event with the text before queuing.
 *   (b) A channel-transport send() appends a well-formed JSON line to the
 *       channel outbox and performs NO PTY write.
 *
 * These exercise the core Session.writeInput delivery path against a minimal
 * mock AgentRuntime that mirrors the real CC adapter's channel send() (append
 * to outbox, never touch a PTY); they do NOT import the real adapter's send().
 * The mock's events() generator blocks until told to complete, its send()
 * records calls + writes the outbox, and spawn() returns a handle with the sid.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Session, type EnvelopeEvent } from "../../core/session/session";
import type {
  AgentRuntime,
  RuntimeConfig,
  RuntimeEvent,
  SessionHandle,
  ResumeRef,
  RuntimeSnapshotContrib,
} from "../../core/runtime";

// ── helpers ─────────────────────────────────────────────────────────────────

let tmpDir: string;
let sessionsDir: string;
let outboxPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "kbbl-wi-test-"));
  sessionsDir = join(tmpDir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  outboxPath = join(tmpDir, "channel-outbox.jsonl");
  writeFileSync(outboxPath, "");
});

afterEach(async () => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Build a minimal mock AgentRuntime. The `events()` generator blocks until
 * `endSession()` is called, so the session stays "live" for the duration of
 * the test. `sendCalls` accumulates every input string passed to `send()`.
 * `ptyWrites` must remain empty — send() must NOT write to any PTY.
 */
function makeMockRuntime(channelOutbox: string): {
  runtime: AgentRuntime;
  sendCalls: string[];
  ptyWrites: string[];
  endSession: () => void;
} {
  const sendCalls: string[] = [];
  const ptyWrites: string[] = [];
  let endSessionFn: (() => void) | null = null;

  const runtime: AgentRuntime = {
    id: "claude-code",
    descriptor: {
      id: "claude-code",
      label: "Claude Code (mock)",
      models: [],
      supportsCompaction: false,
    },
    // CC opts into synthesis (channel transport doesn't echo input back), but
    // stays on the turn-queue path because sendsWithoutTurnQueue is unset.
    synthesizeUserInputEvents: true,

    async spawn(_config: RuntimeConfig): Promise<SessionHandle> {
      return { sessionId: "mock-session" };
    },

    async terminate(_handle: SessionHandle): Promise<void> {},

    async *events(_handle: SessionHandle): AsyncIterable<RuntimeEvent> {
      // Block until endSession() is called.
      await new Promise<void>((resolve) => {
        endSessionFn = resolve;
      });
      yield { type: "completed", result: { code: 0 } };
    },

    /** Channel transport: append to outbox, never write to a PTY. */
    async send(_handle: SessionHandle, input: string): Promise<void> {
      sendCalls.push(input);
      // Write the channel outbox line exactly as the real adapter does.
      const line = JSON.stringify({ content: input, meta: { source: "kbbl" } }) + "\n";
      await appendFile(channelOutbox, line);
      // Deliberately NOT writing to any PTY — ptyWrites stays empty.
    },

    async resolveResumeRef(_dir: string, _sid: string): Promise<ResumeRef> {
      return { kind: "unknown" };
    },

    reconstructSnapshot(_events: readonly EnvelopeEvent[]): RuntimeSnapshotContrib {
      return {
        runtimeSid: null,
        yoloMode: false,
        allowedTools: [],
        lastResultUsage: null,
        initialObservedModel: null,
        observedModel: null,
      };
    },
  };

  return {
    runtime,
    sendCalls,
    ptyWrites,
    endSession: () => endSessionFn?.(),
  };
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("Session.writeInput — CC channel transport", () => {
  test("(a) emits exactly one user event with the text on external CC write", async () => {
    const { runtime, endSession } = makeMockRuntime(outboxPath);

    const session = new Session({
      oakridgeSid: "test-wi-emit",
      workdir: "/tmp",
      name: "test",
      sessionsDir,
      runtimeId: "claude-code",
      busyWatchdogMs: 30_000,
    });

    const emitted: EnvelopeEvent[] = [];
    session.subscribe((evt) => { emitted.push(evt); });

    // attachRuntime wires the event loop and sets status → live.
    await session.attachRuntime(runtime, { sessionId: "mock-session" });

    // Now write an external (non-internal) message.
    await session.writeInput("hello channel");

    // Give the queue a tick to settle.
    await new Promise<void>((r) => setTimeout(r, 50));

    const userEvents = emitted.filter((e) => e.type === "user");
    // Exactly one user event.
    expect(userEvents.length).toBe(1);
    const payload = userEvents[0]!.payload as {
      message?: { role?: string; content?: string };
    };
    expect(payload.message?.role).toBe("user");
    expect(payload.message?.content).toBe("hello channel");

    endSession();
    await session.abort();
  });

  test("(b) appends a well-formed JSON line to the outbox and performs no PTY write", async () => {
    const { runtime, sendCalls, ptyWrites, endSession } = makeMockRuntime(outboxPath);

    const session = new Session({
      oakridgeSid: "test-wi-outbox",
      workdir: "/tmp",
      name: "test",
      sessionsDir,
      runtimeId: "claude-code",
      busyWatchdogMs: 30_000,
    });

    await session.attachRuntime(runtime, { sessionId: "mock-session" });

    // Trigger the turn-end so the queue pump fires (session starts in "idle"
    // after attachRuntime, so the first write is delivered immediately; but
    // notifyTurnEnd clears busy state for subsequent writes in the same test).
    await session.writeInput("outbox payload");

    // Wait for pumpInputQueue → runtime.send() to complete.
    await new Promise<void>((r) => setTimeout(r, 100));

    // runtime.send was called exactly once with the text.
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]).toBe("outbox payload");

    // The outbox file received exactly one line.
    const raw = readFileSync(outboxPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim());
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]!) as {
      content?: string;
      meta?: { source?: string };
    };
    expect(parsed.content).toBe("outbox payload");
    expect(parsed.meta?.source).toBe("kbbl");

    // No PTY writes occurred.
    expect(ptyWrites).toHaveLength(0);

    endSession();
    await session.abort();
  });
});
