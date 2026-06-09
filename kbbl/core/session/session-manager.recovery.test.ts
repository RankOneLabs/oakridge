/**
 * Tests for SessionManager.relaunch() — A.2 continue-in-place recovery.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KbblConfigSchema } from "../config";
import { SessionManager } from "./session-manager";
import { createRuntimeRegistry } from "../runtime";
import type {
  AgentRuntime,
  RuntimeConfig,
  RuntimeDescriptor,
  RuntimeEvent,
  ResumeRef,
  RuntimeId,
  RuntimeSnapshotContrib,
  SessionHandle,
} from "../runtime";
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
  tmpRoot = mkdtempSync(join(tmpdir(), "kbbl-recovery-test-"));
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

interface SpawnCall {
  config: RuntimeConfig;
}

function makeRecoveryRuntime(opts: {
  ccSid: string;
  workdir: string;
}): AgentRuntime & { spawnCalls: SpawnCall[] } {
  const spawnCalls: SpawnCall[] = [];
  const descriptor: RuntimeDescriptor = {
    id: "claude-code",
    label: "Claude Code",
    models: [{ value: "claude-sonnet-4-6", label: "sonnet 4.6" }],
    supportsCompaction: true,
  };
  const runtime: AgentRuntime & { spawnCalls: SpawnCall[] } = {
    id: "claude-code" as RuntimeId,
    descriptor,
    spawnCalls,
    async spawn(config: RuntimeConfig): Promise<SessionHandle> {
      spawnCalls.push({ config });
      return { sessionId: config.runtimeSpecific?.oakridgeSid as string ?? "handle-id" };
    },
    async terminate(_handle: SessionHandle): Promise<void> {},
    async *events(_handle: SessionHandle): AsyncIterable<RuntimeEvent> {
      yield { type: "completed", result: { code: 0 } };
    },
    async send(_handle: SessionHandle, _input: string): Promise<void> {},
    async resolveResumeRef(
      _sessionsDir: string,
      _sid: string,
    ): Promise<ResumeRef> {
      return {
        kind: "ok",
        runtimeSid: opts.ccSid,
        workdir: opts.workdir,
        parentWorktreePath: null,
        model: null,
      };
    },
    reconstructSnapshot(_events: readonly EnvelopeEvent[]): RuntimeSnapshotContrib {
      return {
        runtimeSid: opts.ccSid,
        yoloMode: false,
        allowedTools: [],
        lastResultUsage: null,
        initialObservedModel: null,
        observedModel: null,
      };
    },
  };
  return runtime;
}

function writeMinimalJsonl(sessionsDir: string, oakridgeSid: string, workdir: string, ccSid: string): void {
  const events = [
    {
      id: 0,
      type: "session_started",
      ts: "2026-01-01T00:00:00.000Z",
      payload: {
        workdir,
        name: `session-${oakridgeSid.slice(0, 8)}`,
        runtimeId: "claude-code",
        parentCcSid: null,
        parentOakridgeSid: null,
      },
    },
    {
      id: 1,
      type: "cc_session_id_observed",
      ts: "2026-01-01T00:00:01.000Z",
      payload: { cc_session_id: ccSid },
    },
    {
      id: 2,
      type: "runtime_session_observed",
      ts: "2026-01-01T00:00:01.000Z",
      payload: { runtime_sid: ccSid, runtime_id: "claude-code" },
    },
    {
      id: 3,
      type: "subprocess_exited",
      ts: "2026-01-01T00:01:00.000Z",
      payload: { code: 0, reason: "clean" },
    },
  ];
  const content = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(join(sessionsDir, `${oakridgeSid}.jsonl`), content);
}

describe("SessionManager.relaunch", () => {
  test("resolves ccSid from JSONL and spawns with resumeCcSid (no fork)", async () => {
    const oakridgeSid = "aabbccdd11223344";
    const ccSid = "cc-session-xyz";
    writeMinimalJsonl(sessionsDir, oakridgeSid, repoDir, ccSid);

    const runtime = makeRecoveryRuntime({ ccSid, workdir: repoDir });
    const registry = createRuntimeRegistry([runtime]);
    const manager = new SessionManager({
      sessionsDir,
      handoffsDir: join(tmpRoot, "handoffs"),
      worktreesDir,
      registry,
      config: KbblConfigSchema.parse({}),
    });

    const session = await manager.relaunch(oakridgeSid);
    await session.waitForEnd();

    expect(session.oakridgeSid as string).toBe(oakridgeSid);
    expect(session.status).toBe("ended");
    expect(runtime.spawnCalls.length).toBe(1);
    const spawnConfig = runtime.spawnCalls[0].config;
    // continue-in-place: resumeCcSid set, parentCcSid NOT set
    expect(spawnConfig.runtimeSpecific?.resumeCcSid).toBe(ccSid);
    expect(spawnConfig.runtimeSpecific?.parentCcSid).toBeUndefined();
  });

  test("returns session with same oakridgeSid in the live map", async () => {
    const oakridgeSid = "aabbccdd11223344";
    const ccSid = "cc-session-abc";
    writeMinimalJsonl(sessionsDir, oakridgeSid, repoDir, ccSid);

    const runtime = makeRecoveryRuntime({ ccSid, workdir: repoDir });
    const registry = createRuntimeRegistry([runtime]);
    const manager = new SessionManager({
      sessionsDir,
      handoffsDir: join(tmpRoot, "handoffs"),
      worktreesDir,
      registry,
      config: KbblConfigSchema.parse({}),
    });

    await manager.relaunch(oakridgeSid);
    expect(manager.get(oakridgeSid)).toBeDefined();
    await manager.endAll();
  });

  test("throws if session is already live in memory", async () => {
    const oakridgeSid = "aabbccdd11223344";
    const ccSid = "cc-session-live";
    writeMinimalJsonl(sessionsDir, oakridgeSid, repoDir, ccSid);

    // First relaunch — session becomes live while the runtime's events() is
    // still draining. We intercept spawn to get the handle so we can keep the
    // session live for the second relaunch attempt.
    let pendingResolve: (() => void) | null = null;
    const descriptor: RuntimeDescriptor = {
      id: "claude-code",
      label: "Claude Code",
      models: [],
      supportsCompaction: true,
    };
    const holdingRuntime: AgentRuntime = {
      id: "claude-code" as RuntimeId,
      descriptor,
      async spawn(config: RuntimeConfig): Promise<SessionHandle> {
        return { sessionId: config.runtimeSpecific?.oakridgeSid as string ?? "h" };
      },
      async terminate(_handle: SessionHandle): Promise<void> {
        pendingResolve?.();
      },
      async *events(_handle: SessionHandle): AsyncIterable<RuntimeEvent> {
        await new Promise<void>((r) => { pendingResolve = r; });
        yield { type: "completed", result: { code: 0 } };
      },
      async send(): Promise<void> {},
      async resolveResumeRef(): Promise<ResumeRef> {
        return { kind: "ok", runtimeSid: ccSid, workdir: repoDir, parentWorktreePath: null, model: null };
      },
      reconstructSnapshot(): RuntimeSnapshotContrib {
        return { runtimeSid: ccSid, yoloMode: false, allowedTools: [], lastResultUsage: null, initialObservedModel: null, observedModel: null };
      },
    };

    const registry = createRuntimeRegistry([holdingRuntime]);
    const manager = new SessionManager({
      sessionsDir,
      handoffsDir: join(tmpRoot, "handoffs"),
      worktreesDir,
      registry,
      config: KbblConfigSchema.parse({}),
    });

    const session = await manager.relaunch(oakridgeSid);
    expect(session.status).toBe("live");

    await expect(manager.relaunch(oakridgeSid)).rejects.toThrow(/not ended/);
    await manager.endAll();
  });

  test("startingNextId is seeded past the max id in the existing JSONL", async () => {
    const oakridgeSid = "aabbccdd11223344";
    const ccSid = "cc-session-nextid";
    // JSONL with max id = 3 (subprocess_exited).
    writeMinimalJsonl(sessionsDir, oakridgeSid, repoDir, ccSid);

    const runtime = makeRecoveryRuntime({ ccSid, workdir: repoDir });
    const registry = createRuntimeRegistry([runtime]);
    const manager = new SessionManager({
      sessionsDir,
      handoffsDir: join(tmpRoot, "handoffs"),
      worktreesDir,
      registry,
      config: KbblConfigSchema.parse({}),
    });

    const session = await manager.relaunch(oakridgeSid);
    // The first event emitted by attachRuntime is session_started. It must
    // have id > 3 (the max pre-restart id).
    const firstRecoveryEventId = await new Promise<number>((resolve) => {
      const unsub = session.subscribe((evt) => {
        unsub();
        resolve(evt.id);
      });
    });
    expect(firstRecoveryEventId).toBeGreaterThan(3);
    await session.waitForEnd();
  });

  test("throws for compacted sessions (successor is the live branch)", async () => {
    const oakridgeSid = "aabbccdd11223344";
    const ccSid = "cc-session-compacted";
    // Write a JSONL that looks like a compacted session.
    const events = [
      { id: 0, type: "session_started", ts: "2026-01-01T00:00:00.000Z",
        payload: { workdir: repoDir, name: "s", runtimeId: "claude-code" } },
      { id: 1, type: "cc_session_id_observed", ts: "2026-01-01T00:00:01.000Z",
        payload: { cc_session_id: ccSid } },
      { id: 2, type: "runtime_session_observed", ts: "2026-01-01T00:00:01.000Z",
        payload: { runtime_sid: ccSid, runtime_id: "claude-code" } },
      { id: 3, type: "compact_completed", ts: "2026-01-01T00:01:00.000Z",
        payload: { handoff_doc: {}, successor_sid: "successor-sid-9999" } },
      { id: 4, type: "subprocess_exited", ts: "2026-01-01T00:02:00.000Z",
        payload: { code: 0, reason: "clean" } },
    ];
    writeFileSync(
      join(sessionsDir, `${oakridgeSid}.jsonl`),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );

    const runtime = makeRecoveryRuntime({ ccSid, workdir: repoDir });
    const registry = createRuntimeRegistry([runtime]);
    const manager = new SessionManager({
      sessionsDir,
      handoffsDir: join(tmpRoot, "handoffs"),
      worktreesDir,
      registry,
      config: KbblConfigSchema.parse({}),
    });
    await expect(manager.relaunch(oakridgeSid)).rejects.toThrow(/compacted/);
  });

  test("throws if no registry is configured", async () => {
    const manager = new SessionManager({
      sessionsDir,
      handoffsDir: join(tmpRoot, "handoffs"),
      worktreesDir,
      buildSpawnCmd: async () => ({ cmd: ["true"], cwd: "/tmp", env: {} }),
      config: KbblConfigSchema.parse({}),
    });
    await expect(manager.relaunch("any-sid")).rejects.toThrow(/requires opts.registry/);
  });

  test("throws if JSONL is missing or empty", async () => {
    const runtime = makeRecoveryRuntime({ ccSid: "cc-123", workdir: repoDir });
    const registry = createRuntimeRegistry([runtime]);
    const manager = new SessionManager({
      sessionsDir,
      handoffsDir: join(tmpRoot, "handoffs"),
      worktreesDir,
      registry,
      config: KbblConfigSchema.parse({}),
    });
    await expect(manager.relaunch("nonexistent-sid")).rejects.toThrow(/archived snapshot missing/);
  });

  test("throws if resolveResumeRef returns non-ok", async () => {
    const oakridgeSid = "aabbccdd11223344";
    writeMinimalJsonl(sessionsDir, oakridgeSid, repoDir, "cc-xyz");

    const descriptor: RuntimeDescriptor = {
      id: "claude-code",
      label: "Claude Code",
      models: [],
      supportsCompaction: true,
    };
    const badRefRuntime: AgentRuntime = {
      id: "claude-code" as RuntimeId,
      descriptor,
      async spawn(): Promise<SessionHandle> { return { sessionId: "h" }; },
      async terminate(): Promise<void> {},
      async *events(): AsyncIterable<RuntimeEvent> { yield { type: "completed", result: { code: 0 } }; },
      async send(): Promise<void> {},
      async resolveResumeRef(): Promise<ResumeRef> { return { kind: "no_runtime_sid" }; },
      reconstructSnapshot(): RuntimeSnapshotContrib {
        return { runtimeSid: null, yoloMode: false, allowedTools: [], lastResultUsage: null, initialObservedModel: null, observedModel: null };
      },
    };

    const registry = createRuntimeRegistry([badRefRuntime]);
    const manager = new SessionManager({
      sessionsDir,
      handoffsDir: join(tmpRoot, "handoffs"),
      worktreesDir,
      registry,
      config: KbblConfigSchema.parse({}),
    });
    await expect(manager.relaunch(oakridgeSid)).rejects.toThrow(/cannot resolve CC session id/);
  });
});
