/**
 * Tests for SessionManager with registry + new opt fields.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KbblConfigSchema } from "../config";
import {
  LAST_ACTIVITY_THROTTLE_MS,
  SessionManager,
} from "./session-manager";
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
import { FilesystemResumableSessionClaims, type ResumableInputDeliveryKey, type ResumableSessionKey } from "./resumable-session";

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
    efforts: [],
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
  test("throttles inbox last-activity deltas to the session-list cadence", () => {
    expect(LAST_ACTIVITY_THROTTLE_MS).toBe(5_000);
  });

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
  test("ensureResumableSession admits one live runtime and sends the initial prompt once", async () => {
    let release: (() => void) | null = null;
    const stopped = new Promise<void>((resolve) => { release = resolve; });
    const sent: string[] = [];
    const runtime = makeNoopRuntime();
    runtime.events = async function* () {
      await stopped;
      yield { type: "completed", result: { code: 0 } };
    };
    runtime.send = async (_handle, input) => { sent.push(input); };
    runtime.terminate = async () => { release?.(); };
    const manager = new SessionManager({
      sessionsDir,
      handoffsDir: join(tmpRoot, "handoffs"),
      worktreesDir,
      registry: createRuntimeRegistry([runtime]),
      config: KbblConfigSchema.parse({}),
    });
    const key = "execution-1:executor-step" as ResumableSessionKey;
    const startSpec = { initial_prompt: "Build exactly once", workdir: repoDir, runtime: "claude-code" as const };
    const results = await Promise.all(Array.from({ length: 20 }, () => manager.ensureResumableSession(key, startSpec)));
    expect(results.filter((result) => result.kind === "started")).toHaveLength(1);
    expect(new Set(results.map((result) => result.session.sid)).size).toBe(1);
    expect(sent).toEqual(["Build exactly once"]);
    await manager.endAll();
  });

  test("deliverResumableInput dispatches one runtime input for concurrent DBOS retries", async () => {
    let release: (() => void) | null = null;
    const stopped = new Promise<void>((resolve) => { release = resolve; });
    const sent: string[] = [];
    const runtime = makeNoopRuntime();
    runtime.events = async function* () { await stopped; yield { type: "completed", result: { code: 0 } }; };
    runtime.send = async (_handle, input) => { sent.push(input); };
    runtime.terminate = async () => { release?.(); };
    const manager = new SessionManager({ sessionsDir, handoffsDir: join(tmpRoot, "handoffs"), worktreesDir, registry: createRuntimeRegistry([runtime]), config: KbblConfigSchema.parse({}) });
    const session = await manager.create({ workdir: repoDir });
    const key = "execution-1:revision-1" as ResumableInputDeliveryKey;
    const receipts = await Promise.all(Array.from({ length: 20 }, () => manager.deliverResumableInput(session.oakridgeSid, key, "Revise the build")));
    expect(sent).toEqual(["Revise the build"]);
    expect(receipts.every((receipt) => receipt.status === "delivered")).toBe(true);
    await manager.endAll();
  });

  test("ensureResumableSession advances a crash orphan and resumes its runtime context", async () => {
    const key = "execution-orphan:executor-step" as ResumableSessionKey;
    const startSpec = { initial_prompt: "Continue the build", workdir: repoDir, runtime: "claude-code" as const };
    const store = new FilesystemResumableSessionClaims(sessionsDir);
    const { claim } = await store.claim(key, startSpec);
    const now = new Date().toISOString();
    const events: EnvelopeEvent[] = [
      { id: 1, type: "session_started", ts: now, payload: { workdir: repoDir, projectWorkdir: repoDir, worktreePath: repoDir, worktreeBranch: "main", runtimeId: "claude-code", name: "orphan" } },
      { id: 2, type: "cc_session_id_observed", ts: now, payload: { cc_session_id: "cc-orphan-runtime" } },
      { id: 3, type: "runtime_process_observed", ts: now, payload: { process_id: 4242 } },
    ];
    await writeFile(join(sessionsDir, `${claim.session_id}.jsonl`), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
    const spawnConfigs: RuntimeConfig[] = [];
    let release: (() => void) | null = null;
    const stopped = new Promise<void>((resolve) => { release = resolve; });
    const runtime = makeNoopRuntime();
    runtime.reconstructSnapshot = () => ({ runtimeSid: "cc-orphan-runtime", yoloMode: false, allowedTools: [], lastResultUsage: null, initialObservedModel: null, observedModel: null });
    runtime.fenceOrphan = async (reference) => reference.processId === 4242 && reference.runtimeSid === "cc-orphan-runtime" ? "fenced" : "unverifiable";
    runtime.spawn = async (config) => { spawnConfigs.push(config); return { sessionId: "replacement" }; };
    runtime.events = async function* () { await stopped; yield { type: "completed", result: { code: 0 } }; };
    runtime.terminate = async () => { release?.(); };
    const manager = new SessionManager({ sessionsDir, handoffsDir: join(tmpRoot, "handoffs"), worktreesDir, registry: createRuntimeRegistry([runtime]), config: KbblConfigSchema.parse({}) });
    const result = await manager.ensureResumableSession(key, startSpec);
    expect(result.kind).toBe("started");
    expect(result.session.sid).not.toBe(claim.session_id);
    expect(spawnConfigs[0]?.runtimeSpecific?.parentCcSid).toBe("cc-orphan-runtime");
    await manager.endAll();
  });

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

  test("seeds the configured default allowlist onto a fresh session", async () => {
    const runtime = makeNoopRuntime();
    const registry: RuntimeRegistry = createRuntimeRegistry([runtime]);
    const manager = new SessionManager({
      sessionsDir,
      handoffsDir: join(tmpRoot, "handoffs"),
      worktreesDir,
      registry,
      config: KbblConfigSchema.parse({}), // default_allowlist = Read, Glob, Grep, Bash
    });
    const session = await manager.create({ workdir: repoDir });
    expect([...session.toolAllowlist].sort()).toEqual([
      "Bash",
      "Glob",
      "Grep",
      "Read",
    ]);
    await session.waitForEnd();
  });

  test("seeds nothing when default_allowlist is empty", async () => {
    const runtime = makeNoopRuntime();
    const registry: RuntimeRegistry = createRuntimeRegistry([runtime]);
    const manager = new SessionManager({
      sessionsDir,
      handoffsDir: join(tmpRoot, "handoffs"),
      worktreesDir,
      registry,
      config: KbblConfigSchema.parse({ sessions: { default_allowlist: [] } }),
    });
    const session = await manager.create({ workdir: repoDir });
    expect([...session.toolAllowlist]).toEqual([]);
    await session.waitForEnd();
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
