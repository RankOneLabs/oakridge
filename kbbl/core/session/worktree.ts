import { join } from "node:path";

/**
 * Per-session git worktree creation. kbbl runs many parallel CC sessions over
 * Tailscale; without isolation they all share one workdir, race on file
 * writes, and a `git checkout` in one flips the branch under all the others.
 * Each session gets its own checkout + branch via `git worktree add`, so
 * diffs are attributable and cross-session edits can't collide.
 *
 * This module is the only place that shells out to `git worktree`. All
 * branch-name and worktree-path conventions live here.
 */

export interface WorktreeCreateOpts {
  /** Operator-supplied source repo (the original workdir). */
  workdir: string;
  /** `<dataDir>/<worktree_dir_name>` — parent of all per-session worktrees. */
  worktreesRoot: string;
  /** Full oakridge sid; used for the worktree directory name + branch sid8. */
  oakridgeSid: string;
  /**
   * 0 = fresh session (branch = `kbbl/<sid8>`); n > 0 = resume of depth `n`
   * from the unresumed origin (branch = `kbbl/<sid8>-r<n>`). Branch name
   * encodes chain depth so it's visible in `git branch` without needing to
   * cross-reference JSONL.
   */
  resumeDepth?: number;
}

export interface WorktreeCreated {
  worktreePath: string;
  worktreeBranch: string;
  /** Resolved sha1 from `git rev-parse HEAD` at create time. */
  worktreeBaseRef: string;
}

export class WorktreeCreateError extends Error {
  readonly stderr: string;
  constructor(message: string, stderr: string) {
    super(message);
    this.name = "WorktreeCreateError";
    this.stderr = stderr;
  }
}

/**
 * Returns true if `path` is inside a git working tree (or is a bare repo).
 * Uses `git -C <path> rev-parse --git-dir` because it tolerates being run
 * from any subdirectory of the repo, not just the root — a `stat .git`
 * check would miss sessions opened in a subdirectory.
 *
 * Returns false for non-repos. Throws on unexpected failures (git missing,
 * permission errors) so the caller can distinguish "definitely not a repo"
 * from "couldn't tell."
 */
export async function isGitRepo(path: string): Promise<boolean> {
  const proc = Bun.spawn({
    cmd: ["git", "-C", path, "rev-parse", "--git-dir"],
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code === 0) return true;
  // git exits 128 for "not a git repository" and similar known errors.
  // Anything else (missing binary, signal) is a real failure.
  if (code === 128) return false;
  const stderr = await new Response(proc.stderr).text();
  throw new Error(
    `isGitRepo(${path}) failed with exit ${code}: ${stderr.trim()}`,
  );
}

/**
 * Resolves HEAD to a sha1. Used to capture the base ref at worktree create
 * time so the value persisted to JSONL is immutable (resolving a branch
 * name later could yield a different commit).
 */
export async function resolveHead(path: string): Promise<string> {
  const proc = Bun.spawn({
    cmd: ["git", "-C", path, "rev-parse", "HEAD"],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(
      `git rev-parse HEAD failed in ${path} (exit ${code}): ${stderr.trim()}`,
    );
  }
  return stdout.trim();
}

function branchName(sid8: string, resumeDepth: number): string {
  return resumeDepth > 0 ? `kbbl/${sid8}-r${resumeDepth}` : `kbbl/${sid8}`;
}

export async function createWorktree(
  opts: WorktreeCreateOpts,
): Promise<WorktreeCreated> {
  const sid8 = opts.oakridgeSid.slice(0, 8);
  const branch = branchName(sid8, opts.resumeDepth ?? 0);
  const worktreePath = join(opts.worktreesRoot, opts.oakridgeSid);
  const baseRef = await resolveHead(opts.workdir);

  // --no-track: kbbl branches are local-only session ephemera, never pushed
  // to a remote, so suppressing upstream tracking avoids polluting
  // `git branch -vv` and prevents an accidental `git push` from kicking a
  // kbbl/<sid> branch up to origin.
  const args = [
    "-C",
    opts.workdir,
    "worktree",
    "add",
    "--no-track",
    "-b",
    branch,
    worktreePath,
    baseRef,
  ];
  const proc = Bun.spawn({
    cmd: ["git", ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, code] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new WorktreeCreateError(
      `git worktree add failed for ${worktreePath} (exit ${code})`,
      stderr.trim(),
    );
  }
  return { worktreePath, worktreeBranch: branch, worktreeBaseRef: baseRef };
}

/**
 * Best-effort removal: `git worktree remove --force` then `git branch -D`.
 * Errors are swallowed-and-logged rather than thrown, because the caller
 * (DELETE handler, end-of-session reaper) has already committed to its
 * primary action — the JSONL unlink succeeded — and a leftover worktree is
 * recoverable manually or via the Phase 2 reconcile pass. Returns true if
 * the worktree directory is gone after the call.
 */
export async function removeWorktree(opts: {
  workdir: string;
  worktreePath: string;
  worktreeBranch: string;
}): Promise<boolean> {
  const wt = Bun.spawn({
    cmd: [
      "git",
      "-C",
      opts.workdir,
      "worktree",
      "remove",
      "--force",
      opts.worktreePath,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [wtStderr, wtCode] = await Promise.all([
    new Response(wt.stderr).text(),
    wt.exited,
  ]);
  if (wtCode !== 0) {
    console.error(
      `kbbl: git worktree remove ${opts.worktreePath} failed: ${wtStderr.trim()}`,
    );
    return false;
  }
  // Branch removal can legitimately fail if the branch is already gone (e.g.
  // operator deleted it manually). Log either way; success of the worktree
  // removal is what matters for the orphan-prevention contract.
  const br = Bun.spawn({
    cmd: ["git", "-C", opts.workdir, "branch", "-D", opts.worktreeBranch],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [brStderr, brCode] = await Promise.all([
    new Response(br.stderr).text(),
    br.exited,
  ]);
  if (brCode !== 0) {
    console.error(
      `kbbl: git branch -D ${opts.worktreeBranch} failed: ${brStderr.trim()}`,
    );
  }
  return true;
}

/**
 * Returns true if `child` is the same as or a descendant of `parent`. Used
 * by the startup nesting check to refuse a worktreesRoot that's inside the
 * operator's git tree (where git would happily create nested worktrees that
 * pollute the outer repo's `git status` if the path isn't gitignored).
 *
 * Pure path comparison after normalizing trailing slashes — no symlink
 * resolution. Operators running with symlinked workdirs are responsible for
 * passing already-resolved paths (which `validateWorkdir` does via
 * node:path.resolve()).
 */
export function isPathInside(child: string, parent: string): boolean {
  const c = child.replace(/\/+$/, "");
  const p = parent.replace(/\/+$/, "");
  if (c === p) return true;
  return c.startsWith(`${p}/`);
}
