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
  RuntimeId,
  RuntimeRegistry,
  RuntimeSnapshotContrib,
  SessionHandle,
} from "../runtime";
import { createRuntimeRegistry } from "../runtime";
import type { EnvelopeEvent } from "./session";

let tmpRoot: string;
let sessionsDir: string;
let worktreesDir: string;
let repoDir: string;

async function gitInitRepo(dir: string): Promise<void> {
  const cmds: string[][] = [
    ["git", "-C", dir, "init", "-q", "-b", "main"],
    ["git", "-C", dir, "config", "user.email", "test@example.com"],
    ["git", "-C", dir, "config", "user.name", "test"],
    ["git", "-C", dir, "config", "commit.gpgsign", "false"],
    ["git", "-C", dir, "config", "tag.gpgsign", "false"],
    ["git", "-C", dir, "commit", "--allow-empty", "-q", "-m", "init"],
  ];
  for (const cmd of cmds) {
    const p = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe" });
    const [stderr, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
    if (code !== 0) throw new Error(`${cmd.join(" ")} failed (exit ${code}): ${stderr}`);
  }
}

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kbbl-sm-test-"));
  sessionsDir = join(tmpRoot, "sessions");
  worktreesDir = join(tmpRoot, "worktrees");
  repoDir = join(tmpRoot, "repo");
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(worktreesDir, { recursive: true });
  mkdirSync(repoDir, { recursive: true });
  await gitInitRepo(repoDir);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

async function noopSpawn(_session: Session): Promise<SpawnCmd> {
  return { cmd: ["true"], cwd: "/tmp", env: {} };
}

function makeNoopRuntime(id: RuntimeId = "claude-code"): AgentRuntime {
  const descriptor: RuntimeDescriptor = {
    id,
    label: id === "claude-code" ? "Claude Code" : "Codex",
    models: [{ value: "claude-sonnet-4-6", label: "sonnet 4.6" }],
    supportsCompaction: true,
  };
  return {
    id,
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
        initialObservedModel: null,
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
      config: KbblConfigSchema.parse({}),
    });
    const session = await manager.create({ workdir: repoDir });
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
      config: KbblConfigSchema.parse({}),
    });
    const session = await manager.create({ workdir: repoDir });
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
      config: KbblConfigSchema.parse({}),
    });
    // create() returns once the session is live; waitForEnd() lets us verify
    // the noop runtime's event loop ran to completion.
    const session = await manager.create({ workdir: repoDir });
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

  test("uses configured defaultId when provided", () => {
    const ccRuntime = makeNoopRuntime("claude-code");
    const codexRuntime = makeNoopRuntime("codex");
    const registry = createRuntimeRegistry([ccRuntime, codexRuntime], "codex");
    expect(registry.defaultId).toBe("codex");
  });

  test("rejects configured defaultId when it is not registered", () => {
    const runtime = makeNoopRuntime("claude-code");
    expect(() => createRuntimeRegistry([runtime], "codex")).toThrow(
      /configured default runtime "codex" is not registered/,
    );
  });

  test("stores runtime by id", () => {
    const runtime = makeNoopRuntime();
    const registry = createRuntimeRegistry([runtime]);
    expect(registry.runtimes.get("claude-code")).toBe(runtime);
  });
});

describe("CreateSessionOpts.runtime", () => {
  test("provided runtime overrides the default", async () => {
    // Register both claude-code (default) and codex so the override is proven
    // against a non-default choice, not just a round-trip of the default.
    const ccRuntime = makeNoopRuntime("claude-code");
    const codexRuntime = makeNoopRuntime("codex");
    const registry: RuntimeRegistry = createRuntimeRegistry([ccRuntime, codexRuntime]);
    const manager = new SessionManager({
      sessionsDir,
      handoffsDir: join(tmpRoot, "handoffs"),
      worktreesDir,
      registry,
      config: KbblConfigSchema.parse({}),
    });
    const session = await manager.create({ workdir: repoDir, runtime: "codex" });
    await session.waitForEnd();
    expect(session.runtimeId).toBe("codex");
  });

  test("unknown runtime rejects before session is created", async () => {
    const runtime = makeNoopRuntime();
    const registry: RuntimeRegistry = createRuntimeRegistry([runtime]);
    const manager = new SessionManager({
      sessionsDir,
      handoffsDir: join(tmpRoot, "handoffs"),
      worktreesDir,
      registry,
      config: KbblConfigSchema.parse({}),
    });
    // "codex" is not registered (only claude-code is in this registry).
    await expect(
      manager.create({ workdir: repoDir, runtime: "codex" }),
    ).rejects.toThrow(/runtime "codex" is not registered/);
    // No session should have been added to the manager.
    expect(manager.list().length).toBe(0);
  });
});
