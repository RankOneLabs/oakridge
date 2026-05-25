/**
 * Tests for SessionManager with registry + new opt fields.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KbblConfigSchema } from "../config";
import { SessionManager } from "./session-manager";
import type { Session, SpawnCmd } from "./session";
import type {
  AgentRuntime,
  RuntimeConfig,
  RuntimeDescriptor,
  RuntimeEvent,
  ResumeRef,
  RuntimeRegistry,
  RuntimeSnapshotContrib,
  SessionHandle,
} from "../runtime";
import { createRuntimeRegistry } from "../runtime";
import type { EnvelopeEvent } from "./session";

let tmpRoot: string;
let sessionsDir: string;
let worktreesDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kbbl-sm-test-"));
  sessionsDir = join(tmpRoot, "sessions");
  worktreesDir = join(tmpRoot, "worktrees");
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(worktreesDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

async function noopSpawn(_session: Session): Promise<SpawnCmd> {
  return { cmd: ["true"], cwd: "/tmp", env: {} };
}

function makeNoopRuntime(): AgentRuntime {
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
      return { sessionId: "noop-handle" };
    },
    async terminate(_handle: SessionHandle): Promise<void> {},
    async *events(_handle: SessionHandle): AsyncIterable<RuntimeEvent> {
      // Immediately complete.
      yield { type: "completed", result: { code: 0 } };
    },
    async send(_handle: SessionHandle, _input: string): Promise<void> {},
    async resolveResumeRef(
      _sessionsDir: string,
      _sid: string,
    ): Promise<ResumeRef> {
      return { kind: "unknown" };
    },
    reconstructSnapshot(
      _events: readonly EnvelopeEvent[],
    ): RuntimeSnapshotContrib {
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

describe("SessionManager.getByCcSid", () => {
  test("returns undefined when no lookupByCcSid is provided", () => {
    const manager = new SessionManager({
      sessionsDir,
      handoffsDir: join(tmpRoot, "handoffs"),
      worktreesDir,
      buildSpawnCmd: noopSpawn,
      config: KbblConfigSchema.parse({}),
    });
    expect(manager.getByCcSid("any")).toBeUndefined();
  });

  test("delegates to lookupByCcSid when provided", () => {
    const fakeSession = { oakridgeSid: "fake-sid" } as Session;
    const manager = new SessionManager({
      sessionsDir,
      handoffsDir: join(tmpRoot, "handoffs"),
      worktreesDir,
      buildSpawnCmd: noopSpawn,
      lookupByCcSid: (ccSid) => (ccSid === "cc-123" ? fakeSession : undefined),
      config: KbblConfigSchema.parse({}),
    });
    expect(manager.getByCcSid("cc-123")).toBe(fakeSession);
    expect(manager.getByCcSid("other")).toBeUndefined();
  });
});

describe("SessionManager onRuntimeSessionObserved/onRuntimeSessionEnded", () => {
  test("onRuntimeSessionObserved fires when runtime session id is observed", async () => {
    const observed: Array<[string, string]> = [];
    const manager = new SessionManager({
      sessionsDir,
      handoffsDir: join(tmpRoot, "handoffs"),
      worktreesDir,
      buildSpawnCmd: noopSpawn,
      onRuntimeSessionObserved: (session, runtimeSid) => {
        observed.push([session.oakridgeSid, runtimeSid]);
      },
      config: KbblConfigSchema.parse({
        sessions: { worktree_per_session: false },
      }),
    });
    const session = await manager.create({ workdir: "/tmp" });
    await session.observeRuntimeSessionId("runtime-sid-abc");
    await manager.endAll();
    expect(observed.some(([, sid]) => sid === "runtime-sid-abc")).toBe(true);
  });

  test("onRuntimeSessionEnded fires when session ends", async () => {
    const ended: string[] = [];
    const manager = new SessionManager({
      sessionsDir,
      handoffsDir: join(tmpRoot, "handoffs"),
      worktreesDir,
      buildSpawnCmd: noopSpawn,
      onRuntimeSessionEnded: (session) => {
        ended.push(session.oakridgeSid);
      },
      config: KbblConfigSchema.parse({
        sessions: { worktree_per_session: false },
      }),
    });
    const session = await manager.create({ workdir: "/tmp" });
    const sid = session.oakridgeSid;
    await manager.endAll();
    expect(ended.includes(sid)).toBe(true);
  });
});

describe("SessionManager.create with registry", () => {
  test("uses registry runtime when provided (noop-complete case)", async () => {
    const runtime = makeNoopRuntime();
    const registry: RuntimeRegistry = createRuntimeRegistry([runtime]);
    const manager = new SessionManager({
      sessionsDir,
      handoffsDir: join(tmpRoot, "handoffs"),
      worktreesDir,
      registry,
      config: KbblConfigSchema.parse({
        sessions: { worktree_per_session: false },
      }),
    });
    // create() returns once the session is live; waitForEnd() lets us verify
    // the noop runtime's event loop ran to completion.
    const session = await manager.create({ workdir: "/tmp" });
    await session.waitForEnd();
    expect(session.status).toBe("ended");
    expect(session.runtimeId).toBe("claude-code");
  });
});

describe("createRuntimeRegistry", () => {
  test("sets defaultId to claude-code", () => {
    const runtime = makeNoopRuntime();
    const registry = createRuntimeRegistry([runtime]);
    expect(registry.defaultId).toBe("claude-code");
  });

  test("stores runtime by id", () => {
    const runtime = makeNoopRuntime();
    const registry = createRuntimeRegistry([runtime]);
    expect(registry.runtimes.get("claude-code")).toBe(runtime);
  });
});

describe("CreateSessionOpts.runtime", () => {
  test("provided runtime overrides the default", async () => {
    const runtime = makeNoopRuntime();
    const registry: RuntimeRegistry = createRuntimeRegistry([runtime]);
    const manager = new SessionManager({
      sessionsDir,
      handoffsDir: join(tmpRoot, "handoffs"),
      worktreesDir,
      registry,
      config: KbblConfigSchema.parse({
        sessions: { worktree_per_session: false },
      }),
    });
    const session = await manager.create({ workdir: "/tmp", runtime: "claude-code" });
    await session.waitForEnd();
    expect(session.runtimeId).toBe("claude-code");
  });

  test("unknown runtime rejects before session is created", async () => {
    const runtime = makeNoopRuntime();
    const registry: RuntimeRegistry = createRuntimeRegistry([runtime]);
    const manager = new SessionManager({
      sessionsDir,
      handoffsDir: join(tmpRoot, "handoffs"),
      worktreesDir,
      registry,
      config: KbblConfigSchema.parse({
        sessions: { worktree_per_session: false },
      }),
    });
    // "codex" is not registered (only claude-code is in this registry).
    await expect(
      manager.create({ workdir: "/tmp", runtime: "codex" }),
    ).rejects.toThrow(/runtime "codex" is not registered/);
    // No session should have been added to the manager.
    expect(manager.list().length).toBe(0);
  });
});
