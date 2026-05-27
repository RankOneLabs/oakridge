import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KbblConfigSchema, type KbblConfig } from "../config";
import { classifyCcEvent } from "../../adapters/claude-code/event-classifier";
import { SessionManager } from "./session-manager";
import type { Session, SpawnCmd } from "./session";

let tmpRoot: string;
let sessionsDir: string;
let worktreesDir: string;
let handoffsDir: string;

const mockCcPath = join(import.meta.dir, "__fixtures__", "mock-cc.ts");

function buildConfig(
  overrides: Partial<KbblConfig["compact"]> = {},
): KbblConfig {
  const base = KbblConfigSchema.parse({});
  return {
    ...base,
    compact: { ...base.compact, ...overrides },
  };
}

async function spawnEcho(_session: Session): Promise<SpawnCmd> {
  return {
    cmd: ["bun", "run", mockCcPath],
    cwd: tmpRoot,
    env: {
      ...process.env,
      MOCK_CC_BEHAVIOR: "echo_compact_reply",
    } as Record<string, string>,
  };
}

async function spawnGarbage(_session: Session): Promise<SpawnCmd> {
  return {
    cmd: ["bun", "run", mockCcPath],
    cwd: tmpRoot,
    env: {
      ...process.env,
      MOCK_CC_BEHAVIOR: "garbage_reply",
    } as Record<string, string>,
  };
}

async function spawnStall(_session: Session): Promise<SpawnCmd> {
  return {
    cmd: ["bun", "run", mockCcPath],
    cwd: tmpRoot,
    env: {
      ...process.env,
      MOCK_CC_BEHAVIOR: "stall",
    } as Record<string, string>,
  };
}

function makeManager(opts: {
  spawn: (s: Session) => Promise<SpawnCmd>;
  config?: Partial<KbblConfig["compact"]>;
}): SessionManager {
  return new SessionManager({
    sessionsDir,
    handoffsDir,
    worktreesDir,
    buildSpawnCmd: opts.spawn,
    classifyEvent: classifyCcEvent,
    config: buildConfig(opts.config),
  });
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function waitForStatus(
  session: Session,
  target: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (session.status === target) return;
    await Bun.sleep(20);
  }
  throw new Error(
    `waitForStatus(${target}) timed out after ${timeoutMs}ms; last=${session.status}`,
  );
}

async function gitInit(dir: string): Promise<void> {
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
    await p.exited;
  }
}

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kbbl-runcompact-test-"));
  sessionsDir = join(tmpRoot, "sessions");
  worktreesDir = join(tmpRoot, "worktrees");
  handoffsDir = join(tmpRoot, "handoffs");
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(worktreesDir, { recursive: true });
  // SessionManager requires a git repo for the spawn cwd; initialize tmpRoot
  // itself so every `workdir: tmpRoot` call satisfies the invariant.
  await gitInit(tmpRoot);
  // worktreesDir is inside tmpRoot, so gitignore it to pass ensureWorktreesDirSafeForRepo.
  writeFileSync(join(tmpRoot, ".gitignore"), "worktrees\nsessions\nhandoffs\n");
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("runCompact happy path", () => {
  test("persists handoff, spawns successor", async () => {
    const mgr = makeManager({ spawn: spawnEcho });
    const session = await mgr.create({ workdir: tmpRoot });
    const oldSid = session.oakridgeSid;

    await mgr.runCompact(oldSid, { kind: "manual" });
    await waitForStatus(session, "ended", 5000);
    await mgr.drainLifecycle();

    expect(existsSync(join(handoffsDir, `${oldSid}.md`))).toBe(true);
    const md = readFileSync(join(handoffsDir, `${oldSid}.md`), "utf8");
    expect(md).toContain("Finish the build plan.");

    const successor = mgr
      .list()
      .find((s) => s.parentOakridgeSid === oldSid);
    expect(successor).toBeDefined();

    expect(session.endReason).toBe("compacted");
    expect(session.status).toBe("ended");
    const successorSnap = successor!.snapshot();
    const oldSnap = session.snapshot();
    expect(oldSnap.endReason).toBe("compacted");
    expect(oldSnap.successorSid).toBe(successor!.oakridgeSid);
    expect(oldSnap.status).toBe("ended");
    expect(successorSnap.endReason).toBeNull();
    expect(successorSnap.successorSid).toBeNull();

    await mgr.endAll();
    await mgr.drainLifecycle();
  }, 15000);
});

describe("runCompact failure modes", () => {
  test("compact timeout: status reverts to live, compact_failed{phase:timeout}", async () => {
    const mgr = makeManager({
      spawn: spawnStall,
      config: { compact_call_timeout_seconds: 1 },
    });
    const session = await mgr.create({ workdir: tmpRoot });
    const oldSid = session.oakridgeSid;

    await mgr.runCompact(oldSid, { kind: "manual" });
    await session.flushTranscript();

    expect(session.status).toBe("live");

    const events = readJsonl(join(sessionsDir, `${oldSid}.jsonl`));
    const failed = events.find((e) => e.type === "compact_failed");
    expect(failed).toBeDefined();
    expect((failed!.payload as { phase: string }).phase).toBe("timeout");

    const successor = mgr.list().find((s) => s.parentOakridgeSid === oldSid);
    expect(successor).toBeUndefined();

    await mgr.endAll();
    await mgr.drainLifecycle();
  }, 15000);

  test("garbage parse: successor still spawns with raw_markdown", async () => {
    const mgr = makeManager({ spawn: spawnGarbage });
    const session = await mgr.create({ workdir: tmpRoot });
    const oldSid = session.oakridgeSid;

    await mgr.runCompact(oldSid, { kind: "manual" });
    await waitForStatus(session, "ended", 5000);
    await mgr.drainLifecycle();

    const successor = mgr.list().find((s) => s.parentOakridgeSid === oldSid);
    expect(successor).toBeDefined();

    const md = readFileSync(join(handoffsDir, `${oldSid}.md`), "utf8");
    expect(md).toBe("no structure");

    expect(session.endReason).toBe("compacted");

    await mgr.endAll();
    await mgr.drainLifecycle();
  }, 15000);

  test("successor spawn failure: compact_succeeded_but_resume_failed; old session stays live", async () => {
    let callCount = 0;
    const switchSpawn = async (s: Session): Promise<SpawnCmd> => {
      callCount++;
      if (callCount === 1) return spawnEcho(s);
      // Force Bun.spawn to throw ENOENT for the successor.
      return {
        cmd: ["/this/path/does/not/exist/mock-cc-fail"],
        cwd: tmpRoot,
        env: { ...process.env } as Record<string, string>,
      };
    };
    const mgr = makeManager({ spawn: switchSpawn });
    const session = await mgr.create({ workdir: tmpRoot });
    const oldSid = session.oakridgeSid;

    await mgr.runCompact(oldSid, { kind: "manual" });
    await mgr.drainLifecycle();
    await session.flushTranscript();

    expect(existsSync(join(handoffsDir, `${oldSid}.md`))).toBe(true);

    const events = readJsonl(join(sessionsDir, `${oldSid}.jsonl`));
    const resumeFailed = events.find(
      (e) => e.type === "compact_succeeded_but_resume_failed",
    );
    expect(resumeFailed).toBeDefined();

    expect(session.status).toBe("live");

    await mgr.endAll();
    await mgr.drainLifecycle();
  }, 15000);
});

describe("requestManualCompact", () => {
  test("not_found when no session with that sid", async () => {
    const mgr = makeManager({ spawn: spawnEcho });
    const result = mgr.requestManualCompact("00000000-0000-4000-8000-000000000000");
    expect(result).toBe("not_found");
    await mgr.endAll();
    await mgr.drainLifecycle();
  });

  test("not_live when session is not live", async () => {
    const mgr = makeManager({ spawn: spawnEcho });
    const session = await mgr.create({ workdir: tmpRoot });
    const sid = session.oakridgeSid;
    await mgr.runCompact(sid, { kind: "manual" });
    await waitForStatus(session, "ended", 5000);
    const result = mgr.requestManualCompact(sid);
    expect(result).toBe("not_live");
    await mgr.endAll();
    await mgr.drainLifecycle();
  }, 15000);

  test("ok and fires compaction on live session", async () => {
    const mgr = makeManager({ spawn: spawnEcho });
    const session = await mgr.create({ workdir: tmpRoot });
    const sid = session.oakridgeSid;
    const result = mgr.requestManualCompact(sid);
    expect(result).toBe("ok");
    await waitForStatus(session, "ended", 5000);
    expect(session.endReason).toBe("compacted");
    await mgr.endAll();
    await mgr.drainLifecycle();
  }, 15000);
});

describe("runCompact compactor wiring", () => {
  test("initialMessage is sent to successor", async () => {
    const mgr = makeManager({ spawn: spawnEcho });
    const session = await mgr.create({ workdir: tmpRoot });
    const oldSid = session.oakridgeSid;

    await mgr.runCompact(oldSid, { kind: "manual" });
    await mgr.drainLifecycle();

    const successor = mgr.list().find((s) => s.parentOakridgeSid === oldSid);
    expect(successor).toBeDefined();

    // Give the successor a moment to receive stdin and emit a result
    // event back. The mock-cc echoes a `result` for any line it reads,
    // so the successor's JSONL should contain at least one result event
    // shortly after writeInput(handoff.raw_markdown).
    const deadline = Date.now() + 3000;
    let successorEvents: Array<Record<string, unknown>> = [];
    while (Date.now() < deadline) {
      successorEvents = readJsonl(
        join(sessionsDir, `${successor!.oakridgeSid}.jsonl`),
      );
      if (successorEvents.some((e) => e.type === "result")) break;
      await Bun.sleep(50);
    }
    expect(successorEvents.some((e) => e.type === "result")).toBe(true);

    await mgr.endAll();
    await mgr.drainLifecycle();
  }, 15000);
});
