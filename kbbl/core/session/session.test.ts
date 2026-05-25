/**
 * Tests for Session.attachRuntime() and related new functionality.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
        observedModel: null,
      };
    },
  };
}

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
    await session.writeInput("hello codex");

    expect(sent).toEqual(["hello codex"]);
    const userEvent = emitted.find((e) => e.type === "user");
    expect(userEvent).toBeDefined();
    expect(
      (userEvent!.payload as { message: { content: string } }).message.content,
    ).toBe("hello codex");

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
