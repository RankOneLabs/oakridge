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
