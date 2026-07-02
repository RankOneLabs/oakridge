/**
 * Tests for Session.attachRuntime() and related new functionality.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Session,
  type SessionCallbacks,
  type SessionOpts,
} from "./session";
import type {
  AgentRuntime,
  RuntimeDescriptor,
  RuntimeEvent,
  ResumeRef,
  RuntimeConfig,
  RuntimeSnapshotContrib,
  SessionHandle,
} from "../runtime";
import type { EnvelopeEvent } from "./session";

let tmpRoot: string;
let sessionsDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kbbl-session-test-"));
  sessionsDir = join(tmpRoot, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeSession(overrides: Partial<SessionOpts> = {}): Session {
  return new Session({
    oakridgeSid: overrides.oakridgeSid ?? "test-session-id",
    workdir: overrides.workdir ?? "/tmp",
    name: overrides.name ?? "test",
    sessionsDir,
    runtimeId: overrides.runtimeId ?? "claude-code",
    ...overrides,
  });
}

function makeRuntime(
  eventsToEmit: RuntimeEvent[] = [],
): AgentRuntime {
  const descriptor: RuntimeDescriptor = {
    id: "claude-code",
    label: "Claude Code",
    models: [{ value: "claude-sonnet-4-6", label: "sonnet 4.6" }],
    efforts: [],
    supportsCompaction: true,
  };

  return {
    id: "claude-code",
    descriptor,
    async spawn(_config: RuntimeConfig): Promise<SessionHandle> {
      return { sessionId: "fake-handle" };
    },
    async terminate(_handle: SessionHandle): Promise<void> {},
    async *events(_handle: SessionHandle): AsyncIterable<RuntimeEvent> {
      for (const evt of eventsToEmit) {
        yield evt;
      }
    },
    async send(_handle: SessionHandle, _input: string): Promise<void> {},
    async resolveResumeRef(_sessionsDir: string, _sid: string): Promise<ResumeRef> {
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
}

describe("Session.interrupt", () => {
  // A runtime whose events() blocks on `finish` keeps the session "live" so
  // interrupt() exercises its real (live + attached) path rather than the
  // not-live early return.
  function liveRuntime(extra: Partial<AgentRuntime>): {
    runtime: AgentRuntime;
    finish: () => void;
  } {
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const runtime = {
      ...makeRuntime(),
      async *events(_handle: SessionHandle): AsyncIterable<RuntimeEvent> {
        await done;
        yield { type: "completed", result: { code: 0 } };
      },
      ...extra,
    } satisfies AgentRuntime;
    return { runtime, finish };
  }

  test("delegates to runtime.interrupt and returns ok when live", async () => {
    const interrupted: SessionHandle[] = [];
    const { runtime, finish } = liveRuntime({
      async interrupt(handle: SessionHandle): Promise<void> {
        interrupted.push(handle);
      },
    });
    const session = makeSession();
    const handle = await runtime.spawn({ workingDirectory: "/tmp" });
    await session.attachRuntime(runtime, handle);

    expect(await session.interrupt()).toEqual({ ok: true });
    expect(interrupted).toEqual([handle]);

    finish();
    await session.waitForEnd();
  });

  test("reports 'unsupported' when the runtime exposes no interrupt affordance", async () => {
    const { runtime, finish } = liveRuntime({});
    const session = makeSession();
    const handle = await runtime.spawn({ workingDirectory: "/tmp" });
    await session.attachRuntime(runtime, handle);

    expect(await session.interrupt()).toEqual({ ok: false, reason: "unsupported" });

    finish();
    await session.waitForEnd();
  });

  test("converts a throwing runtime.interrupt into an 'io_failed' value", async () => {
    const { runtime, finish } = liveRuntime({
      async interrupt(_handle: SessionHandle): Promise<void> {
        throw new Error("no proc for session");
      },
    });
    const session = makeSession();
    const handle = await runtime.spawn({ workingDirectory: "/tmp" });
    await session.attachRuntime(runtime, handle);

    // This path is expected to log the runtime failure; suppress the noise and
    // assert the log fired so the logging is part of the contract under test,
    // not incidental output.
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const outcome = await session.interrupt();
      expect(outcome.ok).toBe(false);
      expect(outcome).toMatchObject({ reason: "io_failed", detail: "no proc for session" });
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }

    finish();
    await session.waitForEnd();
  });

  test("reports 'not_live' once the session is no longer live", async () => {
    const interrupted: SessionHandle[] = [];
    const { runtime, finish } = liveRuntime({
      async interrupt(handle: SessionHandle): Promise<void> {
        interrupted.push(handle);
      },
    });
    const session = makeSession();
    const handle = await runtime.spawn({ workingDirectory: "/tmp" });
    await session.attachRuntime(runtime, handle);
    finish();
    await session.waitForEnd();

    expect(await session.interrupt()).toEqual({ ok: false, reason: "not_live" });
    expect(interrupted).toEqual([]);
  });
});

describe("Session runtimeId", () => {
  test("defaults to claude-code when not specified", () => {
    const session = makeSession();
    expect(session.runtimeId).toBe("claude-code");
  });

  test("accepts codex runtimeId", () => {
    const session = makeSession({ runtimeId: "codex" });
    expect(session.runtimeId).toBe("codex");
  });
});

describe("Session.snapshot() runtimeId and runtimeSid", () => {
  test("snapshot includes runtimeId and runtimeSid", () => {
    const session = makeSession({ runtimeId: "claude-code" });
    const snap = session.snapshot();
    expect(snap.runtimeId).toBe("claude-code");
    expect(snap.runtimeSid).toBeNull();
    expect(snap.ccSid).toBeNull();
  });

  test("ccSid and runtimeSid are both set after observeRuntimeSessionId", async () => {
    const session = makeSession();
    await session.observeRuntimeSessionId("test-cc-sid-123");
    const snap = session.snapshot();
    expect(snap.runtimeSid).toBe("test-cc-sid-123");
    expect(snap.ccSid).toBe("test-cc-sid-123");
  });
});

describe("Session.observeRuntimeSessionId emits both events", () => {
  test("emits cc_session_id_observed and runtime_session_observed", async () => {
    const emitted: Array<{ type: string; payload: unknown }> = [];
    const callbacks: SessionCallbacks = {
      onEmit: (_session, evt) => {
        emitted.push({ type: evt.type, payload: evt.payload });
      },
    };
    const session = makeSession({ callbacks });
    await session.observeRuntimeSessionId("sess-abc");

    const ccObserved = emitted.find((e) => e.type === "cc_session_id_observed");
    expect(ccObserved).toBeDefined();
    expect((ccObserved!.payload as { cc_session_id: string }).cc_session_id).toBe("sess-abc");

    const runtimeObserved = emitted.find((e) => e.type === "runtime_session_observed");
    expect(runtimeObserved).toBeDefined();
    expect((runtimeObserved!.payload as { runtime_sid: string }).runtime_sid).toBe("sess-abc");
    expect((runtimeObserved!.payload as { runtime_id: string }).runtime_id).toBe("claude-code");
  });

  test("onRuntimeSessionObserved callback fires", async () => {
    const observed: string[] = [];
    const callbacks: SessionCallbacks = {
      onRuntimeSessionObserved: (_session, runtimeSid) => {
        observed.push(runtimeSid);
      },
    };
    const session = makeSession({ callbacks });
    await session.observeRuntimeSessionId("sess-xyz");
    expect(observed).toEqual(["sess-xyz"]);
  });
});

describe("Session.attachRuntime", () => {
  test("session goes live and ends after empty events", async () => {
    const session = makeSession();
    const runtime = makeRuntime([{ type: "completed", result: { code: 0 } }]);
    const handle = await runtime.spawn({ workingDirectory: "/tmp" });
    await session.attachRuntime(runtime, handle);
    await session.waitForEnd();
    expect(session.status).toBe("ended");
  });

  test("emits session_started with runtimeId", async () => {
    const started: unknown[] = [];
    const callbacks: SessionCallbacks = {
      onEmit: (_session, evt) => {
        if (evt.type === "session_started") started.push(evt.payload);
      },
    };
    const session = makeSession({ callbacks, runtimeId: "claude-code" });
    const runtime = makeRuntime([{ type: "completed", result: { code: 0 } }]);
    const handle = await runtime.spawn({ workingDirectory: "/tmp" });
    await session.attachRuntime(runtime, handle);
    expect(started.length).toBe(1);
    expect((started[0] as { runtimeId: string }).runtimeId).toBe("claude-code");
  });

  test("writeInput records a user event for attached runtimes", async () => {
    const sent: string[] = [];
    const emitted: Array<{ type: string; payload: unknown }> = [];
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const runtime = {
      ...makeRuntime(),
      id: "codex",
      descriptor: {
        id: "codex",
        label: "Codex",
        models: [],
        efforts: [],
        supportsCompaction: false,
      },
      synthesizeUserInputEvents: true,
      sendsWithoutTurnQueue: true,
      async *events(_handle: SessionHandle): AsyncIterable<RuntimeEvent> {
        await done;
        yield { type: "completed", result: { code: 0 } };
      },
      async send(_handle: SessionHandle, input: string): Promise<void> {
        sent.push(input);
      },
    } satisfies AgentRuntime;
    const session = makeSession({
      runtimeId: "codex",
      callbacks: {
        onEmit: (_session, evt) => {
          emitted.push({ type: evt.type, payload: evt.payload });
        },
      },
    });

    const handle = await runtime.spawn({ workingDirectory: "/tmp" });
    await session.attachRuntime(runtime, handle);
    await session.writeInput("hello codex");

    expect(sent).toEqual(["hello codex"]);
    const userEvent = emitted.find((e) => e.type === "user");
    expect(userEvent).toBeDefined();
    expect(
      (userEvent!.payload as { message: { content: string } }).message.content,
    ).toBe("hello codex");

    await session.writeInput("internal handoff", { internal: true });

    expect(sent).toEqual(["hello codex", "internal handoff"]);
    const internalUserEvents = emitted.filter(
      (e) =>
        e.type === "user" &&
        (e.payload as { message?: { content?: string } }).message?.content ===
          "internal handoff",
    );
    expect(internalUserEvents).toHaveLength(0);

    finish();
    await session.waitForEnd();
  });

  test("writeInput does not synthesize user events unless the runtime opts in", async () => {
    const sent: string[] = [];
    const emitted: Array<{ type: string; payload: unknown }> = [];
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const runtime = {
      ...makeRuntime(),
      async *events(_handle: SessionHandle): AsyncIterable<RuntimeEvent> {
        await done;
        yield { type: "completed", result: { code: 0 } };
      },
      async send(_handle: SessionHandle, input: string): Promise<void> {
        sent.push(input);
      },
    } satisfies AgentRuntime;
    const session = makeSession({
      callbacks: {
        onEmit: (_session, evt) => {
          emitted.push({ type: evt.type, payload: evt.payload });
        },
      },
    });

    const handle = await runtime.spawn({ workingDirectory: "/tmp" });
    await session.attachRuntime(runtime, handle);
    await session.writeInput("hello claude");

    expect(sent).toEqual(["hello claude"]);
    expect(emitted.filter((e) => e.type === "user")).toHaveLength(0);

    finish();
    await session.waitForEnd();
  });

  test("envelope events are processed by classifyEvent", async () => {
    const classified: unknown[] = [];
    const runtime = makeRuntime([
      { type: "envelope", payload: { type: "custom_event", data: 42 } },
      { type: "completed", result: { code: 0 } },
    ]);
    (runtime as unknown as { classifyEvent: (e: unknown) => Promise<void> }).classifyEvent =
      async (rawEvent: unknown) => {
        classified.push(rawEvent);
      };

    const session = makeSession();
    const handle = await runtime.spawn({ workingDirectory: "/tmp" });
    await session.attachRuntime(runtime, handle);
    await session.waitForEnd();
    expect(classified.length).toBe(1);
    expect((classified[0] as { type: string }).type).toBe("custom_event");
  });

  test("abort on already-ended attachRuntime session does not throw", async () => {
    // abort() returns early when session is already ended — no terminate call.
    const runtime: AgentRuntime = makeRuntime([
      { type: "completed", result: { code: 0 } },
    ]);

    const session = makeSession();
    const handle = await runtime.spawn({ workingDirectory: "/tmp" });
    await session.attachRuntime(runtime, handle);
    await session.abort();
    expect(session.status).toBe("ended");
  });
});

// Helper: a runtime that stays alive until finish() is called, records sends.
function makeControllableRuntime(): {
  runtime: AgentRuntime;
  sent: string[];
  finish: () => void;
} {
  const sent: string[] = [];
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });

  const runtime: AgentRuntime = {
    ...makeRuntime(),
    async *events(_handle: SessionHandle): AsyncIterable<RuntimeEvent> {
      await done;
      yield { type: "completed", result: { code: 0 } };
    },
    async send(_handle: SessionHandle, input: string): Promise<void> {
      sent.push(input);
    },
  };
  return { runtime, sent, finish };
}

describe("Session input queue (CC PTY mode)", () => {
  test("two external writes while busy: first sent immediately, second queued until notifyTurnEnd", async () => {
    const { runtime, sent, finish } = makeControllableRuntime();
    const session = makeSession();
    const handle = await runtime.spawn({ workingDirectory: "/tmp" });
    await session.attachRuntime(runtime, handle);

    // First write: session is idle → sent immediately.
    await session.writeInput("msg1");
    // Give the queued task a tick to run (pumpInputQueue chains on inputQueue).
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual(["msg1"]);

    // Second write: turnState is now "busy" → queued.
    await session.writeInput("msg2");
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual(["msg1"]); // msg2 still held

    // Turn ends → msg2 is flushed.
    session.notifyTurnEnd();
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual(["msg1", "msg2"]);

    finish();
    await session.waitForEnd();
  });

  test("interrupt mid-turn clears the queue and emits a result (CC has no Stop hook on interrupt)", async () => {
    // Regression: an ESC interrupt fires neither an `end_turn` assistant message
    // nor CC's Stop hook, so without interrupt() driving the turn back to idle,
    // turnState stays "busy" forever — every later message is stranded in the
    // queue (the channel outbox stops being written) and the PWA spinner, which
    // waits on a `result` event, never clears.
    const emitted: Array<{ type: string; payload: unknown }> = [];
    const { runtime: base, sent, finish } = makeControllableRuntime();
    const runtime: AgentRuntime = {
      ...base,
      async interrupt(_handle: SessionHandle): Promise<void> {
        // CC writes a raw ESC; the side effect on turn/queue state is the
        // session's responsibility, which is exactly what's under test.
      },
    };
    const session = makeSession({
      callbacks: {
        onEmit: (_s, evt) => emitted.push({ type: evt.type, payload: evt.payload }),
      },
    });
    const handle = await runtime.spawn({ workingDirectory: "/tmp" });
    await session.attachRuntime(runtime, handle);

    // First write goes out and puts the turn in flight; second is queued behind it.
    await session.writeInput("msg1");
    await new Promise((r) => setTimeout(r, 0));
    // CC produced a transcript line, so the turn is genuinely under way — this
    // is what gates interrupt recovery (not the bare "busy" state, which is set
    // before the turn actually starts).
    session.notifyTurnStarted();
    await session.writeInput("msg2");
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual(["msg1"]); // msg2 held behind the busy turn

    // Interrupt: no Stop hook will follow, so interrupt() must itself recover the
    // queue and emit the result the UI waits on.
    expect(await session.interrupt()).toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 0));

    // Queue un-wedged: the stranded message is delivered.
    expect(sent).toEqual(["msg1", "msg2"]);
    // Spinner-clearing result emitted, tagged as an interrupt (not end_turn, so
    // it never triggers compaction).
    const result = emitted.find((e) => e.type === "result");
    expect(result).toBeDefined();
    expect((result!.payload as { stop_reason: string }).stop_reason).toBe("interrupted");
    // usage MUST be null, not zeros: a zero-usage result would clobber the last
    // meaningful lastResultUsage on archived replay (Resume tooltip → ~0 tokens).
    expect((result!.payload as { usage: unknown }).usage).toBeNull();

    finish();
    await session.waitForEnd();
  });

  test("interrupt in the pre-turn window does NOT flush the queue (no turn observed yet)", async () => {
    // turnState flips to "busy" the moment a message is dispatched, before CC
    // emits any transcript line. An interrupt landing in that window must not
    // synthesize a result or flush msg2 — the busy watchdog owns the "sent but
    // never became a turn" recovery. notifyTurnStarted() is deliberately never
    // called here, so turnObservedStarted stays false.
    const emitted: Array<{ type: string; payload: unknown }> = [];
    const { runtime: base, sent, finish } = makeControllableRuntime();
    const runtime: AgentRuntime = {
      ...base,
      async interrupt(_handle: SessionHandle): Promise<void> {},
    };
    const session = makeSession({
      callbacks: {
        onEmit: (_s, evt) => emitted.push({ type: evt.type, payload: evt.payload }),
      },
    });
    const handle = await runtime.spawn({ workingDirectory: "/tmp" });
    await session.attachRuntime(runtime, handle);

    await session.writeInput("msg1");
    await new Promise((r) => setTimeout(r, 0));
    await session.writeInput("msg2");
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual(["msg1"]);

    expect(await session.interrupt()).toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 0));

    // No synthetic result, and msg2 stays queued — the watchdog, not interrupt,
    // is responsible for recovering a turn that never started.
    expect(emitted.find((e) => e.type === "result")).toBeUndefined();
    expect(sent).toEqual(["msg1"]);

    finish();
    await session.waitForEnd();
  });

  test("order preserved across three queued messages", async () => {
    const { runtime, sent, finish } = makeControllableRuntime();
    const session = makeSession();
    const handle = await runtime.spawn({ workingDirectory: "/tmp" });
    await session.attachRuntime(runtime, handle);

    await session.writeInput("a");
    await session.writeInput("b");
    await session.writeInput("c");

    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual(["a"]); // only first delivered

    session.notifyTurnEnd();
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual(["a", "b"]);

    session.notifyTurnEnd();
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual(["a", "b", "c"]);

    finish();
    await session.waitForEnd();
  });

  test("watchdog re-delivers a swallowed message once, then drops it and recovers the queue", async () => {
    const { runtime, sent, finish } = makeControllableRuntime();
    const session = makeSession({ busyWatchdogMs: 20 });
    const handle = await runtime.spawn({ workingDirectory: "/tmp" });
    await session.attachRuntime(runtime, handle);

    // Dispatched but (simulating a not-yet-ready REPL / swallowing modal) no
    // turn-start is ever observed, so no Stop hook / notifyTurnEnd follows.
    await session.writeInput("eaten");
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual(["eaten"]);

    // Watchdog fires → the message is re-delivered exactly once (a genuinely
    // lost first message must not be silently dropped). The re-delivery also
    // produces no turn, so a second watchdog fires and drops it rather than
    // looping. Both fires land inside this window (margin well above the 20ms
    // watchdog to avoid scheduler-jitter flake).
    await new Promise((r) => setTimeout(r, 80));
    expect(sent).toEqual(["eaten", "eaten"]);

    // A further wait confirms the dropped message is not delivered a third time.
    await new Promise((r) => setTimeout(r, 80));
    expect(sent).toEqual(["eaten", "eaten"]);

    // The queue is recovered: a fresh message dispatches normally (and is not a
    // continuation of "eaten"'s exhausted retry budget).
    await session.writeInput("after");
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual(["eaten", "eaten", "after"]);

    finish();
    await session.waitForEnd();
  });

  test("a message that starts a turn is not re-delivered by the watchdog", async () => {
    const { runtime, sent, finish } = makeControllableRuntime();
    const session = makeSession({ busyWatchdogMs: 20 });
    const handle = await runtime.spawn({ workingDirectory: "/tmp" });
    await session.attachRuntime(runtime, handle);

    await session.writeInput("real");
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual(["real"]);

    // The turn actually started (transcript activity) — cancels the watchdog,
    // so the in-flight message is never re-delivered even past the window.
    session.notifyTurnStarted();
    await new Promise((r) => setTimeout(r, 80));
    expect(sent).toEqual(["real"]);

    finish();
    await session.waitForEnd();
  });

  test("notifyTurnStarted cancels the watchdog so a long turn holds queued messages", async () => {
    const { runtime, sent, finish } = makeControllableRuntime();
    const session = makeSession({ busyWatchdogMs: 20 });
    const handle = await runtime.spawn({ workingDirectory: "/tmp" });
    await session.attachRuntime(runtime, handle);

    await session.writeInput("msg1");
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual(["msg1"]);

    await session.writeInput("msg2");
    // The turn actually started (transcript activity observed) — this cancels
    // the watchdog even though the turn will run longer than busyWatchdogMs.
    session.notifyTurnStarted();

    // Past the watchdog window: msg2 must still be held (turn legitimately busy).
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toEqual(["msg1"]);

    // Only the real turn-end releases msg2.
    session.notifyTurnEnd();
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual(["msg1", "msg2"]);

    finish();
    await session.waitForEnd();
  });

  test("internal write bypasses queue and sends immediately while busy", async () => {
    const { runtime, sent, finish } = makeControllableRuntime();
    const session = makeSession();
    const handle = await runtime.spawn({ workingDirectory: "/tmp" });
    await session.attachRuntime(runtime, handle);

    // Make the session busy by sending one message.
    await session.writeInput("external");
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual(["external"]);

    // Internal write must bypass queue and go out immediately (even while busy).
    await session.writeInput("compact-prompt", { internal: true });
    expect(sent).toEqual(["external", "compact-prompt"]);

    finish();
    await session.waitForEnd();
  });

  test("writeInput during compacting queues; markLive flushes it", async () => {
    const { runtime, sent, finish } = makeControllableRuntime();
    const session = makeSession();
    const handle = await runtime.spawn({ workingDirectory: "/tmp" });
    await session.attachRuntime(runtime, handle);

    // Simulate compaction in progress.
    session.markCompacting();
    expect(session.status).toBe("compacting");

    // External write during compacting must be accepted (not throw).
    await session.writeInput("queued-during-compact");
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toHaveLength(0); // not sent yet (compacting + turnState idle but status not live)

    // Return to live → flush.
    session.markLive();
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual(["queued-during-compact"]);

    finish();
    await session.waitForEnd();
  });

  test("turn-queue runtime that opts into synthesis: write during compacting queues, not rejected", async () => {
    // Regression: the compacting gate must key on sendsWithoutTurnQueue, not
    // synthesizeUserInputEvents. This adversarial shape sets
    // synthesizeUserInputEvents: true while leaving sendsWithoutTurnQueue unset
    // (a turn-queue runtime) — the combination that a gate wrongly keyed on
    // synthesize would reject. (Real CC is a turn-queue runtime too but sets
    // synthesizeUserInputEvents: false; the gate behaviour must not depend on
    // that.) An external write during compaction must be queued + flushed on
    // markLive(), never throw SessionNotReadyError.
    const { runtime, sent, finish } = makeControllableRuntime();
    const ccRuntime: AgentRuntime = {
      ...runtime,
      synthesizeUserInputEvents: true,
      // sendsWithoutTurnQueue deliberately unset — the turn-queue shape.
    };
    const session = makeSession();
    const handle = await ccRuntime.spawn({ workingDirectory: "/tmp" });
    await session.attachRuntime(ccRuntime, handle);

    session.markCompacting();
    expect(session.status).toBe("compacting");

    // Must not throw, must not send yet.
    await session.writeInput("queued-during-cc-compact");
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toHaveLength(0);

    session.markLive();
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual(["queued-during-cc-compact"]);

    finish();
    await session.waitForEnd();
  });

  test("notifyTurnEnd on empty queue is a no-op, leaves state idle", async () => {
    const { runtime, sent, finish } = makeControllableRuntime();
    const session = makeSession();
    const handle = await runtime.spawn({ workingDirectory: "/tmp" });
    await session.attachRuntime(runtime, handle);

    // Queue is empty; calling notifyTurnEnd should not throw and not send.
    session.notifyTurnEnd();
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toHaveLength(0);

    // Another external write should still go through (still idle).
    await session.writeInput("after-noop-turnend");
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual(["after-noop-turnend"]);

    finish();
    await session.waitForEnd();
  });

  test("finalize drops queued messages without further runtime.send", async () => {
    const { runtime, sent, finish } = makeControllableRuntime();
    const session = makeSession();
    const handle = await runtime.spawn({ workingDirectory: "/tmp" });
    await session.attachRuntime(runtime, handle);

    // Make session busy so the next message queues.
    await session.writeInput("first");
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual(["first"]);

    // Queue a second message (will be held while busy).
    await session.writeInput("second-should-drop");

    // Terminate the session before notifyTurnEnd is called.
    finish();
    await session.waitForEnd();

    // The queued message must have been dropped, not sent.
    expect(sent).toEqual(["first"]);
  });

  test("runtime.send failure resets turnState so subsequent messages are delivered", async () => {
    const sent: string[] = [];
    let failNext = false;
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });

    const runtime: AgentRuntime = {
      ...makeRuntime(),
      async *events(_handle: SessionHandle): AsyncIterable<RuntimeEvent> {
        await done;
        yield { type: "completed", result: { code: 0 } };
      },
      async send(_handle: SessionHandle, input: string): Promise<void> {
        if (failNext) {
          failNext = false;
          throw new Error("pty write failed");
        }
        sent.push(input);
      },
    };

    const session = makeSession();
    const handle = await runtime.spawn({ workingDirectory: "/tmp" });
    await session.attachRuntime(runtime, handle);

    // First write: idle → busy, sends successfully.
    await session.writeInput("msg1");
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual(["msg1"]);

    // Arm failure for the next send, then queue a second message.
    failNext = true;
    await session.writeInput("msg2");

    // Turn ends → pump tries msg2, send throws, turnState resets to idle.
    session.notifyTurnEnd();
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toEqual(["msg1"]); // msg2 dropped

    // Session must not be wedged — a new write goes through cleanly.
    await session.writeInput("msg3");
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual(["msg1", "msg3"]);

    finish();
    await session.waitForEnd();
  });
});
