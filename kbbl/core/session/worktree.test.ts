import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WorktreeCreateError,
  createWorktree,
  isGitRepo,
  isPathInside,
  resolveHead,
  removeWorktree,
} from "./worktree";

let tmpRoot: string;
let repoDir: string;
let worktreesRoot: string;

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
  // Disable signing locally — operators with global commit.gpgsign=true
  // would otherwise see this throwaway test repo try (and fail) to sign
  // the init commit. Only affects this tmp repo; never touches user config.
  await git(dir, "config", "commit.gpgsign", "false");
  await git(dir, "config", "tag.gpgsign", "false");
  await git(dir, "commit", "--allow-empty", "-m", "init");
}

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kbbl-worktree-test-"));
  repoDir = join(tmpRoot, "repo");
  worktreesRoot = join(tmpRoot, "worktrees");
  await Bun.write(join(repoDir, ".keep"), "");
  // Bun.write only creates the file; mkdir the parent if needed.
  rmSync(join(repoDir, ".keep"));
  // Re-create cleanly via mkdir -p semantics. node:fs/promises mkdir would
  // also work, but we already have repoDir laid down via Bun.write's
  // implicit mkdir. Re-init explicitly to be sure.
  const init = Bun.spawn({ cmd: ["mkdir", "-p", repoDir, worktreesRoot] });
  await init.exited;
  await initRepo(repoDir);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("isGitRepo", () => {
  test("returns true for an initialized repo", async () => {
    expect(await isGitRepo(repoDir)).toBe(true);
  });

  test("returns true for a subdirectory of a repo", async () => {
    const sub = join(repoDir, "sub");
    const proc = Bun.spawn({ cmd: ["mkdir", "-p", sub] });
    await proc.exited;
    expect(await isGitRepo(sub)).toBe(true);
  });

  test("returns false for a non-repo dir", async () => {
    const notRepo = join(tmpRoot, "plain");
    const proc = Bun.spawn({ cmd: ["mkdir", "-p", notRepo] });
    await proc.exited;
    expect(await isGitRepo(notRepo)).toBe(false);
  });

  test("returns false for a bare repo (no working tree)", async () => {
    // kbbl operates on tracked files via CC, which needs a working tree.
    // A bare repo would also break resolveRepoTopLevel (empty stdout).
    // Easier to reject upfront than handle the bare case downstream.
    const bare = join(tmpRoot, "bare.git");
    await git(tmpRoot, "init", "-q", "--bare", bare);
    expect(await isGitRepo(bare)).toBe(false);
  });

  test("throws on a nonexistent path (not silently 'not a repo')", async () => {
    // git -C <missing> exits 128 with "cannot change to '<path>': No such
    // file or directory" — same exit code as "not a git repository" but a
    // distinct cause. Pre-fix we'd swallow this and silently disable
    // worktrees; post-fix it throws so the operator sees the real problem.
    await expect(
      isGitRepo(join(tmpRoot, "definitely-does-not-exist")),
    ).rejects.toThrow();
  });
});

describe("resolveHead", () => {
  test("returns a 40-char sha1 for HEAD", async () => {
    const sha = await resolveHead(repoDir);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  test("throws on non-repo", async () => {
    const notRepo = join(tmpRoot, "plain");
    const proc = Bun.spawn({ cmd: ["mkdir", "-p", notRepo] });
    await proc.exited;
    await expect(resolveHead(notRepo)).rejects.toThrow();
  });
});

describe("createWorktree", () => {
  test("creates a worktree on branch kbbl/<sid8> for a fresh session", async () => {
    const sid = "abcdef0123456789-fresh";
    const created = await createWorktree({
      workdir: repoDir,
      worktreesRoot,
      oakridgeSid: sid,
      resumeDepth: 0,
    });
    expect(created.worktreeBranch).toBe("kbbl/abcdef01");
    expect(created.worktreePath).toBe(join(worktreesRoot, sid));
    expect(created.worktreeBaseRef).toMatch(/^[0-9a-f]{40}$/);
    const cur = (await git(created.worktreePath, "branch", "--show-current")).trim();
    expect(cur).toBe("kbbl/abcdef01");
  });

  test("encodes resumeDepth as -r<n> suffix", async () => {
    const created = await createWorktree({
      workdir: repoDir,
      worktreesRoot,
      oakridgeSid: "11112222deadbeef",
      resumeDepth: 3,
    });
    expect(created.worktreeBranch).toBe("kbbl/11112222-r3");
  });

  test("--no-track is applied: branch has no upstream", async () => {
    const created = await createWorktree({
      workdir: repoDir,
      worktreesRoot,
      oakridgeSid: "33334444eeeeeeee",
    });
    const vv = await git(created.worktreePath, "branch", "-vv");
    // Format: "* kbbl/33334444 <sha> commit-msg" with no [origin/...] tracking marker.
    expect(vv).not.toMatch(/\[/);
  });

  test("fails with WorktreeCreateError when branch already exists", async () => {
    await git(repoDir, "branch", "kbbl/55556666");
    await expect(
      createWorktree({
        workdir: repoDir,
        worktreesRoot,
        oakridgeSid: "55556666cafebabe",
      }),
    ).rejects.toBeInstanceOf(WorktreeCreateError);
  });

  test("fails with WorktreeCreateError when target path already exists", async () => {
    const sid = "77778888feedface";
    const proc = Bun.spawn({ cmd: ["mkdir", "-p", join(worktreesRoot, sid)] });
    await proc.exited;
    await Bun.write(join(worktreesRoot, sid, "blocker"), "x");
    await expect(
      createWorktree({
        workdir: repoDir,
        worktreesRoot,
        oakridgeSid: sid,
      }),
    ).rejects.toBeInstanceOf(WorktreeCreateError);
  });
});

describe("createWorktree — identity and baseRef opts", () => {
  test("identity omitted: produces kbbl/<sid8> branch and <root>/<sid> dir", async () => {
    const sid = "aabbccdd11223344";
    const created = await createWorktree({
      workdir: repoDir,
      worktreesRoot,
      oakridgeSid: sid,
    });
    expect(created.worktreeBranch).toBe("kbbl/aabbccdd");
    expect(created.worktreePath).toBe(join(worktreesRoot, sid));
  });

  test("identity provided: produces slug branch, nested subdir, and /<sid> leaf", async () => {
    const sid = "cohort0123456789a";
    const created = await createWorktree({
      workdir: repoDir,
      worktreesRoot,
      oakridgeSid: sid,
      identity: { branchName: "epic/myepic/cohort-1-myslug", worktreeSubdir: "myepic" },
    });
    expect(created.worktreeBranch).toBe("epic/myepic/cohort-1-myslug");
    expect(created.worktreePath).toBe(join(worktreesRoot, "myepic", sid));
    const cur = (await git(created.worktreePath, "branch", "--show-current")).trim();
    expect(cur).toBe("epic/myepic/cohort-1-myslug");
  });

  test("baseRef provided: worktreeBaseRef equals git rev-parse <baseRef>, sha differs from HEAD", async () => {
    // Second commit so HEAD sha differs from the first-commit sha.
    await git(repoDir, "commit", "--allow-empty", "-m", "second");
    const firstCommitSha = (await git(repoDir, "rev-parse", "HEAD~1")).trim();
    const headSha = (await git(repoDir, "rev-parse", "HEAD")).trim();
    expect(firstCommitSha).not.toBe(headSha);

    const created = await createWorktree({
      workdir: repoDir,
      worktreesRoot,
      oakridgeSid: "basereftest12345",
      identity: { branchName: "epic/e/cohort-1-s", worktreeSubdir: "e" },
      baseRef: "HEAD~1",
    });
    expect(created.worktreeBaseRef).toBe(firstCommitSha);
    const wtHead = (await git(created.worktreePath, "rev-parse", "HEAD")).trim();
    expect(wtHead).toBe(firstCommitSha);
  });

  test("resumeDepth > 0 with identity: -r<n> appended to slug branch, dir unchanged", async () => {
    const sid = "resumeid123456789";
    const created = await createWorktree({
      workdir: repoDir,
      worktreesRoot,
      oakridgeSid: sid,
      identity: { branchName: "epic/foo/cohort-1-bar", worktreeSubdir: "foo" },
      resumeDepth: 2,
    });
    expect(created.worktreeBranch).toBe("epic/foo/cohort-1-bar-r2");
    expect(created.worktreePath).toBe(join(worktreesRoot, "foo", sid));
  });

  test("identity-provided branch: no --no-track means upstream tracking is configured", async () => {
    // Set up a bare remote so origin/main is a real remote-tracking ref.
    const remoteDir = join(tmpRoot, "remote.git");
    const mkproc = Bun.spawn({ cmd: ["mkdir", "-p", remoteDir] });
    await mkproc.exited;
    await git(remoteDir, "init", "--bare", "-b", "main");
    await git(repoDir, "remote", "add", "origin", remoteDir);
    await git(repoDir, "push", "origin", "main");
    await git(repoDir, "fetch", "origin");

    // Branch from origin/main so git auto-sets upstream tracking (only when
    // --no-track is absent). With --no-track, git branch -vv would show no
    // [origin/...] marker and git push (no args) would fail.
    const created = await createWorktree({
      workdir: repoDir,
      worktreesRoot,
      oakridgeSid: "pushtest0123456789",
      identity: { branchName: "epic/e/cohort-1-push", worktreeSubdir: "e" },
      baseRef: "origin/main",
    });

    // Tracking is set up: git branch -vv shows [origin/main] on this branch.
    // This only happens when --no-track is absent; with --no-track the line
    // would have no [...] marker at all.
    const vv = await git(created.worktreePath, "branch", "-vv");
    expect(vv).toMatch(/\[origin\/main\]/);

    // Explicit push to origin also succeeds (new branch, so force isn't needed).
    const pushProc = Bun.spawn({
      cmd: ["git", "-C", created.worktreePath, "push", "origin", "epic/e/cohort-1-push"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const [, , pushCode] = await Promise.all([
      new Response(pushProc.stdout).text(),
      new Response(pushProc.stderr).text(),
      pushProc.exited,
    ]);
    expect(pushCode).toBe(0);
  });
});

describe("removeWorktree", () => {
  test("removes both the worktree directory and the branch", async () => {
    const created = await createWorktree({
      workdir: repoDir,
      worktreesRoot,
      oakridgeSid: "99990000aaaabbbb",
    });
    const ok = await removeWorktree({
      workdir: repoDir,
      worktreePath: created.worktreePath,
      worktreeBranch: created.worktreeBranch,
    });
    expect(ok).toBe(true);
    const branches = await git(repoDir, "branch", "--list", created.worktreeBranch);
    expect(branches.trim()).toBe("");
  });

  test("returns false when the worktree path is gone (and logs)", async () => {
    const ok = await removeWorktree({
      workdir: repoDir,
      worktreePath: join(worktreesRoot, "never-existed"),
      worktreeBranch: "kbbl/00000000",
    });
    expect(ok).toBe(false);
  });

  test("still deletes the branch even if the worktree dir was manually pruned", async () => {
    // Operator manually `rm -rf`s the worktree dir + `git worktree prune`s,
    // then the kbbl session is removed via the API. The `git worktree
    // remove` call will fail (nothing to remove), but the kbbl/<sid>
    // branch is still in the repo and would leak forever pre-fix.
    const created = await createWorktree({
      workdir: repoDir,
      worktreesRoot,
      oakridgeSid: "abcd1234deadbeef",
    });
    rmSync(created.worktreePath, { recursive: true, force: true });
    await git(repoDir, "worktree", "prune");

    const ok = await removeWorktree({
      workdir: repoDir,
      worktreePath: created.worktreePath,
      worktreeBranch: created.worktreeBranch,
    });
    // worktree-remove failed → false; branch deletion is the side benefit.
    expect(ok).toBe(false);
    const branches = await git(repoDir, "branch", "--list", created.worktreeBranch);
    expect(branches.trim()).toBe("");
  });
});

describe("isPathInside", () => {
  test("true when child equals parent", () => {
    expect(isPathInside("/a/b", "/a/b")).toBe(true);
  });

  test("true when child is a descendant", () => {
    expect(isPathInside("/a/b/c", "/a/b")).toBe(true);
  });

  test("false when child is sibling", () => {
    expect(isPathInside("/a/bb", "/a/b")).toBe(false);
  });

  test("trailing slashes don't affect comparison", () => {
    expect(isPathInside("/a/b/", "/a/b")).toBe(true);
    expect(isPathInside("/a/b", "/a/b/")).toBe(true);
  });

  test("false when child is outside parent entirely", () => {
    expect(isPathInside("/x/y", "/a/b")).toBe(false);
  });
});
