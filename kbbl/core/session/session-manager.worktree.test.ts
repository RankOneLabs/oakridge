import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KbblConfigSchema, type KbblConfig } from "../config";
import { SessionManager } from "./session-manager";
import type { Session, SpawnCmd } from "./session";

let tmpRoot: string;
let repoDir: string;
let sessionsDir: string;
let worktreesDir: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn({
    cmd: ["git", "-C", cwd, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} failed (exit ${code}): ${stderr}`);
  }
  return stdout;
}

async function initRepo(dir: string): Promise<void> {
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "config", "user.email", "test@example.com");
  await git(dir, "config", "user.name", "test");
  await git(dir, "config", "commit.gpgsign", "false");
  await git(dir, "config", "tag.gpgsign", "false");
  await git(dir, "commit", "--allow-empty", "-m", "init");
}

function buildConfig(worktreePerSession: boolean): KbblConfig {
  return KbblConfigSchema.parse({
    sessions: { worktree_per_session: worktreePerSession },
  });
}

function noopSpawn(_session: Session): SpawnCmd {
  // `true` exits 0 immediately, so the session reaches "live" briefly then
  // ends. We just need create() to complete; the test asserts on disk +
  // snapshot state, not on the subprocess lifecycle.
  return { cmd: ["true"], cwd: "/tmp", env: {} };
}

function makeManager(config: KbblConfig): SessionManager {
  return new SessionManager({
    sessionsDir,
    worktreesDir,
    buildSpawnCmd: noopSpawn,
    config,
  });
}

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kbbl-mgr-worktree-test-"));
  repoDir = join(tmpRoot, "repo");
  sessionsDir = join(tmpRoot, "sessions");
  worktreesDir = join(tmpRoot, "worktrees");
  const init = Bun.spawn({
    cmd: ["mkdir", "-p", repoDir, sessionsDir, worktreesDir],
  });
  await init.exited;
  await initRepo(repoDir);
});

afterEach(async () => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("SessionManager.create with worktree_per_session: true", () => {
  test("creates a worktree at <worktreesDir>/<sid> on branch kbbl/<sid8>", async () => {
    const mgr = makeManager(buildConfig(true));
    const session = await mgr.create({ workdir: repoDir });
    const sid8 = session.oakridgeSid.slice(0, 8);
    const expectedPath = join(worktreesDir, session.oakridgeSid);

    expect(session.workdir).toBe(expectedPath);
    expect(session.worktreePath).toBe(expectedPath);
    expect(session.worktreeBranch).toBe(`kbbl/${sid8}`);
    expect(session.worktreeBaseRef).toMatch(/^[0-9a-f]{40}$/);
    expect(session.projectWorkdir).toBe(repoDir);

    expect(existsSync(expectedPath)).toBe(true);
    const cur = (await git(expectedPath, "branch", "--show-current")).trim();
    expect(cur).toBe(`kbbl/${sid8}`);
    await mgr.endAll();
  });

  test("snapshot exposes all worktree fields", async () => {
    const mgr = makeManager(buildConfig(true));
    const session = await mgr.create({ workdir: repoDir });
    const snap = session.snapshot();
    expect(snap.worktreePath).toBe(session.worktreePath);
    expect(snap.worktreeBranch).toBe(session.worktreeBranch);
    expect(snap.worktreeBaseRef).toBe(session.worktreeBaseRef);
    expect(snap.projectWorkdir).toBe(repoDir);
    await mgr.endAll();
  });
});

describe("SessionManager.create with worktree_per_session: false", () => {
  test("session.workdir == operator workdir, no worktree on disk", async () => {
    const mgr = makeManager(buildConfig(false));
    const session = await mgr.create({ workdir: repoDir });
    expect(session.workdir).toBe(repoDir);
    expect(session.worktreePath).toBeNull();
    expect(session.worktreeBranch).toBeNull();
    expect(session.worktreeBaseRef).toBeNull();
    expect(session.projectWorkdir).toBeNull();
    // worktreesDir is created by the server, not the manager — but we
    // pre-created it in beforeEach, so the assertion is "no per-session
    // subdir exists".
    expect(existsSync(join(worktreesDir, session.oakridgeSid))).toBe(false);
    await mgr.endAll();
  });
});

describe("SessionManager.create with non-repo workdir + flag on", () => {
  test("falls back to operator workdir, no worktree, no error", async () => {
    const plain = join(tmpRoot, "plain");
    const init = Bun.spawn({ cmd: ["mkdir", "-p", plain] });
    await init.exited;

    const mgr = makeManager(buildConfig(true));
    const session = await mgr.create({ workdir: plain });
    expect(session.workdir).toBe(plain);
    expect(session.worktreePath).toBeNull();
    expect(session.worktreeBranch).toBeNull();
    expect(existsSync(join(worktreesDir, session.oakridgeSid))).toBe(false);
    await mgr.endAll();
  });
});

describe("Resume worktree depth", () => {
  test("first resume off a fresh parent gets -r1 suffix", async () => {
    const mgr = makeManager(buildConfig(true));
    const parent = await mgr.create({ workdir: repoDir });
    const parentSid8 = parent.oakridgeSid.slice(0, 8);
    expect(parent.worktreeBranch).toBe(`kbbl/${parentSid8}`);

    const child = await mgr.create({
      workdir: repoDir,
      parentOakridgeSid: parent.oakridgeSid,
      parentCcSid: "fake-cc-sid",
    });
    const childSid8 = child.oakridgeSid.slice(0, 8);
    expect(child.worktreeBranch).toBe(`kbbl/${childSid8}-r1`);
    await mgr.endAll();
  });

  test("resume of a -r1 parent gets -r2 suffix", async () => {
    const mgr = makeManager(buildConfig(true));
    const parent = await mgr.create({ workdir: repoDir });
    const child = await mgr.create({
      workdir: repoDir,
      parentOakridgeSid: parent.oakridgeSid,
      parentCcSid: "fake",
    });
    const grandchild = await mgr.create({
      workdir: repoDir,
      parentOakridgeSid: child.oakridgeSid,
      parentCcSid: "fake",
    });
    const sid8 = grandchild.oakridgeSid.slice(0, 8);
    expect(grandchild.worktreeBranch).toBe(`kbbl/${sid8}-r2`);
    await mgr.endAll();
  });
});

describe("loadArchivedSnapshot round-trips worktree fields", () => {
  function writeJsonlSession(
    sid: string,
    extras: Record<string, unknown>,
  ): void {
    const ts = new Date().toISOString();
    const sessionStarted = {
      id: 0,
      type: "session_started",
      ts,
      payload: {
        command: ["true"],
        workdir: extras.workdir ?? "/tmp/workdir",
        name: `session-${sid.slice(0, 8)}`,
        sessionId: sid,
        parentCcSid: null,
        parentOakridgeSid: null,
        artifactId: null,
        ...extras,
      },
    };
    Bun.write(
      join(sessionsDir, `${sid}.jsonl`),
      `${JSON.stringify(sessionStarted)}\n`,
    );
  }

  test("Phase-1 JSONL → snapshot exposes worktreePath/Branch/BaseRef/projectWorkdir", async () => {
    const sid = "deadbeef-cafe-1234-5678-aaaaaaaaaaaa";
    writeJsonlSession(sid, {
      workdir: "/tmp/wt-root/" + sid,
      worktreePath: "/tmp/wt-root/" + sid,
      worktreeBranch: "kbbl/deadbeef",
      worktreeBaseRef: "0".repeat(40),
      projectWorkdir: "/home/op/repo",
    });
    // Tiny pause so the file is fully visible to readdir; Bun.write is
    // sync-on-resolve but the manager's first call hits readdir before
    // anything awaits. Belt-and-suspenders.
    await new Promise((r) => setTimeout(r, 10));

    const mgr = makeManager(buildConfig(false));
    const archived = await mgr.listArchivedSnapshots();
    const snap = archived.find((s) => s.sid === sid);
    expect(snap).toBeTruthy();
    expect(snap!.worktreePath).toBe("/tmp/wt-root/" + sid);
    expect(snap!.worktreeBranch).toBe("kbbl/deadbeef");
    expect(snap!.worktreeBaseRef).toBe("0".repeat(40));
    expect(snap!.projectWorkdir).toBe("/home/op/repo");
  });

  test("pre-Phase-1 JSONL (no worktree keys) → snapshot has all four fields null", async () => {
    const sid = "11111111-2222-3333-4444-555555555555";
    writeJsonlSession(sid, {});
    await new Promise((r) => setTimeout(r, 10));

    const mgr = makeManager(buildConfig(false));
    const archived = await mgr.listArchivedSnapshots();
    const snap = archived.find((s) => s.sid === sid);
    expect(snap).toBeTruthy();
    expect(snap!.worktreePath).toBeNull();
    expect(snap!.worktreeBranch).toBeNull();
    expect(snap!.worktreeBaseRef).toBeNull();
    expect(snap!.projectWorkdir).toBeNull();
  });
});

describe("SessionManager.remove cleans up worktrees", () => {
  test("DELETE-equivalent removes the worktree directory and branch", async () => {
    const mgr = makeManager(buildConfig(true));
    const session = await mgr.create({ workdir: repoDir });
    const wtPath = session.worktreePath!;
    const wtBranch = session.worktreeBranch!;
    expect(existsSync(wtPath)).toBe(true);

    const removed = await mgr.remove(session.oakridgeSid);
    expect(removed).toBe(true);
    expect(existsSync(wtPath)).toBe(false);
    const branches = await git(repoDir, "branch", "--list", wtBranch);
    expect(branches.trim()).toBe("");
  });

  test("remove on a pre-Phase-1 session (no worktree) is a no-op for git state", async () => {
    const mgr = makeManager(buildConfig(false));
    const session = await mgr.create({ workdir: repoDir });
    const removed = await mgr.remove(session.oakridgeSid);
    expect(removed).toBe(true);
    // Repo's branches untouched (only main from initRepo).
    const branches = (await git(repoDir, "branch", "--list")).trim();
    expect(branches).toContain("main");
    expect(branches).not.toContain("kbbl/");
  });
});
