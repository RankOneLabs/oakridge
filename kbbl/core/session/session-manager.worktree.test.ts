import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KbblConfigSchema, type KbblConfig } from "../config";
import { SessionManager, parseDepthFromBranch } from "./session-manager";
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

function buildConfig(): KbblConfig {
  return KbblConfigSchema.parse({});
}

async function noopSpawn(_session: Session): Promise<SpawnCmd> {
  // `true` exits 0 immediately, so the session reaches "live" briefly then
  // ends. We just need create() to complete; the test asserts on disk +
  // snapshot state, not on the subprocess lifecycle.
  return { cmd: ["true"], cwd: "/tmp", env: {} };
}

function makeManager(config: KbblConfig): SessionManager {
  return new SessionManager({
    sessionsDir,
    handoffsDir: join(tmpRoot, "handoffs"),
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

describe("SessionManager.create — worktree is mandatory", () => {
  test("creates a worktree at <worktreesDir>/<sid> on branch kbbl/<sid8>", async () => {
    const mgr = makeManager(buildConfig());
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
    const mgr = makeManager(buildConfig());
    const session = await mgr.create({ workdir: repoDir });
    const snap = session.snapshot();
    expect(snap.worktreePath).toBe(session.worktreePath);
    expect(snap.worktreeBranch).toBe(session.worktreeBranch);
    expect(snap.worktreeBaseRef).toBe(session.worktreeBaseRef);
    expect(snap.projectWorkdir).toBe(repoDir);
    await mgr.endAll();
  });

  test("rejects nested worktreesDir when the repo does not ignore it", async () => {
    const nestedWorktreesDir = join(repoDir, ".kbbl-worktrees");
    mkdirSync(nestedWorktreesDir, { recursive: true });
    const mgr = new SessionManager({
      sessionsDir,
      handoffsDir: join(tmpRoot, "handoffs"),
      worktreesDir: nestedWorktreesDir,
      buildSpawnCmd: noopSpawn,
      config: buildConfig(),
    });

    await expect(mgr.create({ workdir: repoDir })).rejects.toThrow(
      /worktreesDir .* is inside the repo .* but is not gitignored/,
    );
  });

  test("rejects spawn when workdir is not a git repo", async () => {
    const plain = join(tmpRoot, "plain");
    const init = Bun.spawn({ cmd: ["mkdir", "-p", plain] });
    await init.exited;

    const mgr = makeManager(buildConfig());
    await expect(mgr.create({ workdir: plain })).rejects.toThrow(
      /is not a git repo/,
    );
    expect(readdirSync(worktreesDir)).toHaveLength(0);
  });
});

describe("Resume worktree depth", () => {
  // POST /sessions resume passes `workdir = parent.workdir`, which is the
  // parent's worktree path, not the operator's repo. Mirroring that here so
  // the tests exercise the production code path — using `repoDir` would skip
  // the projectWorkdir-inheritance logic entirely.
  test("first resume off a fresh parent gets -r1 suffix", async () => {
    const mgr = makeManager(buildConfig());
    const parent = await mgr.create({ workdir: repoDir });
    const parentSid8 = parent.oakridgeSid.slice(0, 8);
    expect(parent.worktreeBranch).toBe(`kbbl/${parentSid8}`);

    const child = await mgr.create({
      workdir: parent.workdir,
      parentOakridgeSid: parent.oakridgeSid,
      parentCcSid: "fake-cc-sid",
    });
    const childSid8 = child.oakridgeSid.slice(0, 8);
    expect(child.worktreeBranch).toBe(`kbbl/${childSid8}-r1`);
    // Inherited from parent so the dual-label still points at the operator's
    // original repo, not at the parent's worktree dir.
    expect(child.projectWorkdir).toBe(repoDir);
    await mgr.endAll();
  });

  test("resume of a -r1 parent gets -r2 suffix", async () => {
    const mgr = makeManager(buildConfig());
    const parent = await mgr.create({ workdir: repoDir });
    const child = await mgr.create({
      workdir: parent.workdir,
      parentOakridgeSid: parent.oakridgeSid,
      parentCcSid: "fake",
    });
    const grandchild = await mgr.create({
      workdir: child.workdir,
      parentOakridgeSid: child.oakridgeSid,
      parentCcSid: "fake",
    });
    const sid8 = grandchild.oakridgeSid.slice(0, 8);
    expect(grandchild.worktreeBranch).toBe(`kbbl/${sid8}-r2`);
    // Resume chain of length 2 still inherits the original repo.
    expect(grandchild.projectWorkdir).toBe(repoDir);
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

  test("worktree-tagged JSONL → snapshot exposes worktreePath/Branch/BaseRef/projectWorkdir", async () => {
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

    const mgr = makeManager(buildConfig());
    const archived = await mgr.listArchivedSnapshots();
    const snap = archived.find((s) => s.sid === sid);
    expect(snap).toBeTruthy();
    expect(snap!.worktreePath).toBe("/tmp/wt-root/" + sid);
    expect(snap!.worktreeBranch).toBe("kbbl/deadbeef");
    expect(snap!.worktreeBaseRef).toBe("0".repeat(40));
    expect(snap!.projectWorkdir).toBe("/home/op/repo");
  });

  test("legacy JSONL (no worktree keys) → snapshot has all four fields null", async () => {
    const sid = "11111111-2222-3333-4444-555555555555";
    writeJsonlSession(sid, {});
    await new Promise((r) => setTimeout(r, 10));

    const mgr = makeManager(buildConfig());
    const archived = await mgr.listArchivedSnapshots();
    const snap = archived.find((s) => s.sid === sid);
    expect(snap).toBeTruthy();
    expect(snap!.worktreePath).toBeNull();
    expect(snap!.worktreeBranch).toBeNull();
    expect(snap!.worktreeBaseRef).toBeNull();
    expect(snap!.projectWorkdir).toBeNull();
  });

  test("compact_completed in JSONL → snapshot exposes endReason + successorSid", async () => {
    const sid = "feedface-cafe-1234-5678-bbbbbbbbbbbb";
    const successorSid = "feedface-cafe-1234-5678-cccccccccccc";
    const baseTs = new Date().toISOString();
    const sessionStarted = {
      id: 0,
      type: "session_started",
      ts: baseTs,
      payload: {
        command: ["true"],
        workdir: "/tmp/workdir",
        name: `session-${sid.slice(0, 8)}`,
        sessionId: sid,
        parentCcSid: null,
        parentOakridgeSid: null,
        artifactId: null,
      },
    };
    const compactCompleted = {
      id: 1,
      type: "compact_completed",
      ts: baseTs,
      payload: {
        handoff_doc: { schema_version: 1 },
        successor_sid: successorSid,
      },
    };
    const subprocessExited = {
      id: 2,
      type: "subprocess_exited",
      ts: baseTs,
      payload: { code: 0, reason: "clean" },
    };
    await Bun.write(
      join(sessionsDir, `${sid}.jsonl`),
      [sessionStarted, compactCompleted, subprocessExited]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n",
    );

    const mgr = makeManager(buildConfig());
    const archived = await mgr.listArchivedSnapshots();
    const snap = archived.find((s) => s.sid === sid);
    expect(snap).toBeTruthy();
    expect(snap!.endReason).toBe("compacted");
    expect(snap!.successorSid).toBe(successorSid);
  });
});

describe("SessionManager.remove cleans up worktrees", () => {
  test("DELETE-equivalent removes the worktree directory and branch", async () => {
    const mgr = makeManager(buildConfig());
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
});

describe("SessionManager.create — worktreeIdentity plumbing", () => {
  let epicWorkdir: string;
  let epicBaseSha: string;

  beforeEach(async () => {
    const bareDir = join(tmpRoot, "epic-remote.git");
    const seedDir = join(tmpRoot, "epic-seed");
    epicWorkdir = join(tmpRoot, "epic-workdir");

    mkdirSync(bareDir, { recursive: true });
    mkdirSync(seedDir, { recursive: true });

    await git(bareDir, "init", "--bare", "-q");

    await initRepo(seedDir);
    await git(seedDir, "remote", "add", "origin", bareDir);
    await git(seedDir, "push", "origin", "main");

    await git(seedDir, "checkout", "-b", "epic/epic_x");
    await git(seedDir, "commit", "--allow-empty", "-m", "epic-x seed");
    await git(seedDir, "push", "origin", "epic/epic_x");

    const cloneProc = Bun.spawn({
      cmd: ["git", "clone", "-q", bareDir, epicWorkdir],
      stdout: "pipe",
      stderr: "pipe",
    });
    await cloneProc.exited;
    await git(epicWorkdir, "config", "user.email", "test@example.com");
    await git(epicWorkdir, "config", "user.name", "test");
    await git(epicWorkdir, "config", "commit.gpgsign", "false");

    epicBaseSha = (await git(epicWorkdir, "rev-parse", "origin/epic/epic_x")).trim();
  });

  test("identity-passing session lands on slug branch, nested path, and base sha", async () => {
    const mgr = makeManager(buildConfig());
    const session = await mgr.create({
      workdir: epicWorkdir,
      worktreeIdentity: {
        epicSlug: "epic_x",
        cohortSlug: "1-foo",
        epicBranch: "epic/epic_x",
      },
    });

    const sid = session.oakridgeSid;

    expect(session.worktreeBranch).toBe("cohort/epic_x/1-foo");
    expect(session.worktreePath).toEndWith(`epic_x/1-foo/${sid}`);
    expect(session.worktreeBaseRef).toBe(epicBaseSha);

    await mgr.endAll();
  });
});

describe("parseDepthFromBranch", () => {
  test("kbbl/<sid8> returns 0", () => {
    expect(parseDepthFromBranch("kbbl/abc12345")).toBe(0);
  });

  test("kbbl/<sid8>-r3 returns 3", () => {
    expect(parseDepthFromBranch("kbbl/abc12345-r3")).toBe(3);
  });

  test("cohort/foo/1-bar returns 0", () => {
    expect(parseDepthFromBranch("cohort/foo/1-bar")).toBe(0);
  });

  test("cohort/foo/1-bar-r2 returns 2", () => {
    expect(parseDepthFromBranch("cohort/foo/1-bar-r2")).toBe(2);
  });

  test("legacy epic/foo/cohort-1-bar no longer matches — warns and returns 0", () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(String(args[0]));
    try {
      const result = parseDepthFromBranch("epic/foo/cohort-1-bar");
      expect(result).toBe(0);
      expect(errors.length).toBeGreaterThan(0);
    } finally {
      console.error = original;
    }
  });

  test("garbage-branch warns and returns 0", () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(String(args[0]));
    try {
      const result = parseDepthFromBranch("garbage-branch");
      expect(result).toBe(0);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toMatch(/garbage-branch/);
    } finally {
      console.error = original;
    }
  });
});
