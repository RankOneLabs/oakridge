/**
 * Terminal observation for resumable sessions: the bounded wait that keeps an
 * observer's request inside the transport's deadline, and the exit-code truth
 * that lets the caller tell a clean finish from a crash.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KbblConfigSchema } from "../config";
import { SessionManager } from "./session-manager";
import { selectTerminalWaitMs, TERMINAL_WAIT_MS_DEFAULT, TERMINAL_WAIT_MS_MAX, type ResumableSessionKey } from "./resumable-session";
import type { SessionId } from "./types";
import type { SpawnCmd } from "./session";

let tmpRoot: string;
let sessionsDir: string;
let repoDir: string;

/** `true` exits the moment it is spawned; `sleep` keeps a session live. */
const spawning = (cmd: readonly string[]) => async (): Promise<SpawnCmd> => ({ cmd: [...cmd], cwd: "/tmp", env: {} });

const makeManager = (cmd: readonly string[] = ["true"]): SessionManager =>
  new SessionManager({
    sessionsDir,
    handoffsDir: join(tmpRoot, "handoffs"),
    worktreesDir: join(tmpRoot, "worktrees"),
    buildSpawnCmd: spawning(cmd),
    config: KbblConfigSchema.parse({}),
  });

/** Sessions require a git workdir — each one is spawned in its own worktree. */
const gitInitRepo = async (dir: string): Promise<void> => {
  const cmds = [
    ["git", "-C", dir, "init", "-q", "-b", "main"],
    ["git", "-C", dir, "config", "user.email", "test@example.com"],
    ["git", "-C", dir, "config", "user.name", "test"],
    ["git", "-C", dir, "config", "commit.gpgsign", "false"],
    ["git", "-C", dir, "commit", "--allow-empty", "-q", "-m", "init"],
  ];
  for (const cmd of cmds) {
    const proc = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe" });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`${cmd.join(" ")} failed (exit ${code}): ${stderr}`);
  }
};

/** Write a minimal archived session JSONL the snapshot loader can reconstruct. */
const archiveSession = async (sid: string, events: readonly Record<string, unknown>[]): Promise<void> => {
  const lines = [
    { type: "session_started", ts: "2026-08-16T00:00:00.000Z", payload: { command: ["claude"], workdir: "/repo", name: sid, sessionId: sid, runtimeId: "claude-code" } },
    ...events,
  ].map((event) => JSON.stringify({ ts: "2026-08-16T00:00:00.000Z", ...event }));
  await writeFile(join(sessionsDir, `${sid}.jsonl`), `${lines.join("\n")}\n`);
};

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kbbl-terminal-"));
  sessionsDir = join(tmpRoot, "sessions");
  repoDir = join(tmpRoot, "repo");
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(repoDir, { recursive: true });
  await gitInitRepo(repoDir);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

test("an unknown session is reported as not found rather than a silent success", async () => {
  expect(await makeManager().waitForResumableSessionTerminal("missing-sid" as SessionId, 0)).toEqual({ kind: "not_found" });
});

test("an archived session reports the exit code recorded when its process died", async () => {
  await archiveSession("crashed", [{ type: "subprocess_exited", payload: { code: 1, reason: "error" } }]);
  const outcome = await makeManager().waitForResumableSessionTerminal("crashed" as SessionId, 0);
  expect(outcome.kind).toBe("terminal");
  if (outcome.kind !== "terminal") return;
  expect(outcome.result.exit_code).toBe(1);
  expect(outcome.result.session.endReason).toBe("subprocess_exited");
});

test("a clean archived session reports exit code zero", async () => {
  await archiveSession("clean", [{ type: "subprocess_exited", payload: { code: 0, reason: "clean" } }]);
  const outcome = await makeManager().waitForResumableSessionTerminal("clean" as SessionId, 0);
  expect(outcome.kind === "terminal" && outcome.result.exit_code).toBe(0);
});

test("an archived session with no recorded exit reports null, never a fabricated zero", async () => {
  await archiveSession("truncated", []);
  const outcome = await makeManager().waitForResumableSessionTerminal("truncated" as SessionId, 0);
  expect(outcome.kind).toBe("terminal");
  if (outcome.kind !== "terminal") return;
  expect(outcome.result.exit_code).toBeNull();
});

test("observation follows a compaction successor to the session that inherited the work", async () => {
  await archiveSession("original", [
    { type: "compact_completed", payload: { successor_sid: "successor" } },
    { type: "subprocess_exited", payload: { code: 0, reason: "clean" } },
  ]);
  await archiveSession("successor", [{ type: "subprocess_exited", payload: { code: 2, reason: "error" } }]);
  const outcome = await makeManager().waitForResumableSessionTerminal("original" as SessionId, 0);
  expect(outcome.kind).toBe("terminal");
  if (outcome.kind !== "terminal") return;
  expect(outcome.result.session.sid).toBe("successor");
  expect(outcome.result.exit_code).toBe(2);
});

test("a successor chain that loops back on itself terminates instead of hanging", async () => {
  await archiveSession("loop-a", [{ type: "compact_completed", payload: { successor_sid: "loop-b" } }]);
  await archiveSession("loop-b", [{ type: "compact_completed", payload: { successor_sid: "loop-a" } }]);
  const outcome = await makeManager().waitForResumableSessionTerminal("loop-a" as SessionId, 0);
  expect(outcome.kind).toBe("not_found");
});

test("a zero wait is a non-blocking poll: a session already ended in memory reads terminal, not pending", async () => {
  const manager = makeManager();
  const session = await manager.create({ workdir: repoDir });
  await manager.endAll();
  const outcome = await manager.waitForResumableSessionTerminal(session.oakridgeSid as SessionId, 0);
  expect(outcome.kind).toBe("terminal");
  if (outcome.kind !== "terminal") return;
  expect(outcome.result.session.status).toBe("ended");
});

test("a zero wait on a session that is still live reads pending", async () => {
  const manager = makeManager(["sleep", "30"]);
  const session = await manager.create({ workdir: repoDir });
  const outcome = await manager.waitForResumableSessionTerminal(session.oakridgeSid as SessionId, 0);
  expect(outcome.kind).toBe("pending");
  await manager.endAll();
});

test("wait_ms is clamped to a value that stays inside the server's idle timeout", () => {
  expect(selectTerminalWaitMs(undefined)).toBe(TERMINAL_WAIT_MS_DEFAULT);
  expect(selectTerminalWaitMs("1000")).toBe(1000);
  expect(selectTerminalWaitMs("999999")).toBe(TERMINAL_WAIT_MS_MAX);
  expect(selectTerminalWaitMs("-5")).toBe(TERMINAL_WAIT_MS_DEFAULT);
  expect(selectTerminalWaitMs("nonsense")).toBe(TERMINAL_WAIT_MS_DEFAULT);
  expect(TERMINAL_WAIT_MS_MAX).toBeLessThan(255_000);
});

test("advancing a claimed key hands the next ensure a fresh session id", async () => {
  const manager = makeManager(["sleep", "30"]);
  const key = "execution-1:v1" as ResumableSessionKey;
  const first = await manager.ensureResumableSession(key, { initial_prompt: "go", workdir: repoDir });
  const advanced = await manager.advanceResumableSession(key);
  expect(advanced.kind).toBe("advanced");
  if (advanced.kind !== "advanced") return;
  expect(advanced.previous_session_id).toBe(first.session.sid as SessionId);
  expect(advanced.session_id).not.toBe(first.session.sid);
  expect(advanced.generation).toBe(1);
  await manager.endAll();
});

test("advancing a key nobody ever claimed reports not found rather than minting one", async () => {
  expect(await makeManager().advanceResumableSession("never-claimed" as ResumableSessionKey)).toEqual({ kind: "not_found" });
});

test("advancing twice moves one generation at a time, never skipping", async () => {
  const manager = makeManager(["sleep", "30"]);
  const key = "execution-2:v1" as ResumableSessionKey;
  await manager.ensureResumableSession(key, { initial_prompt: "go", workdir: repoDir });
  await manager.advanceResumableSession(key);
  const second = await manager.advanceResumableSession(key);
  expect(second.kind === "advanced" && second.generation).toBe(2);
  await manager.endAll();
});

test("a live session is ended before its key is advanced past it", async () => {
  const manager = makeManager(["sleep", "30"]);
  const key = "execution-3:v1" as ResumableSessionKey;
  const started = await manager.ensureResumableSession(key, { initial_prompt: "go", workdir: repoDir });
  expect(started.session.status).not.toBe("ended");
  await manager.advanceResumableSession(key);
  expect(manager.get(started.session.sid)?.snapshot().status).toBe("ended");
  await manager.endAll();
});
