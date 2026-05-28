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
  /**
   * When provided, overrides the branch name and worktree subdirectory.
   * Branch: `identity.branchName` (with `-r<n>` appended if `resumeDepth > 0`).
   * Directory: `<worktreesRoot>/<identity.worktreeSubdir>/<oakridgeSid>`.
   * When omitted, falls through to the default behavior: branch is
   * `kbbl/<sid8>[-r<n>]`, directory is `<worktreesRoot>/<oakridgeSid>`.
   */
  identity?: { branchName: string; worktreeSubdir: string };
  /**
   * When provided, the worktree is branched from this ref (e.g.
   * `origin/epic/foo`), and `worktreeBaseRef` is resolved via
   * `git rev-parse <baseRef>` against `opts.workdir`. When omitted,
   * falls through to `resolveHead(opts.workdir)`.
   */
  baseRef?: string;
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
 * Returns true if `path` is inside a git working tree. Bare repos return
 * false: kbbl operates on tracked files via CC, which needs a working
 * tree, and `resolveRepoTopLevel` would fail downstream on a bare repo
 * anyway.
 *
 * Uses `git rev-parse --is-inside-work-tree`, which tolerates being run
 * from any subdirectory of the repo and distinguishes working tree
 * ("true") from bare repo ("false") by stdout rather than exit code.
 *
 * Returns false for the genuine "not a git repository" case (exit 128 +
 * matching stderr). Throws on any other failure (chdir/EACCES/ENOENT,
 * missing binary, signal) so the caller can't silently disable worktrees
 * because a real I/O problem looked like a non-repo.
 *
 * Forces LC_ALL=C / LANG=C so the stderr probe stays English-stable under
 * non-default operator locales.
 */
export async function isGitRepo(path: string): Promise<boolean> {
  const proc = Bun.spawn({
    cmd: ["git", "-C", path, "rev-parse", "--is-inside-work-tree"],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, LC_ALL: "C", LANG: "C" },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code === 0) return stdout.trim() === "true";
  // git uses exit 128 for both "not a git repository" and other fatals
  // (cannot chdir into <path>, permission errors, ...). Match on stderr so
  // a non-repo returns false but an inaccessible path throws.
  if (code === 128 && /not a git repository/i.test(stderr)) return false;
  throw new Error(
    `isGitRepo(${path}) failed with exit ${code}: ${stderr.trim()}`,
  );
}

/**
 * Resolves the top-level directory of the repo containing `path` via
 * `git rev-parse --show-toplevel`. Used by the startup nesting check so
 * an operator who launches kbbl from a *subdirectory* of a repo still
 * gets `worktreesDir` compared against the actual repo root, not the
 * subdir — otherwise nested worktrees inside the repo could escape the
 * check and pollute `git status` from the outer repo.
 *
 * Caller must ensure `isGitRepo(path)` already returned true.
 */
export async function resolveRepoTopLevel(path: string): Promise<string> {
  const proc = Bun.spawn({
    cmd: ["git", "-C", path, "rev-parse", "--show-toplevel"],
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
      `git rev-parse --show-toplevel failed in ${path} (exit ${code}): ${stderr.trim()}`,
    );
  }
  return stdout.trim();
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
  let branch: string;
  let worktreePath: string;

  if (opts.identity) {
    const depth = opts.resumeDepth ?? 0;
    branch = depth > 0 ? `${opts.identity.branchName}-r${depth}` : opts.identity.branchName;
    worktreePath = join(opts.worktreesRoot, opts.identity.worktreeSubdir, opts.oakridgeSid);
  } else {
    const sid8 = opts.oakridgeSid.slice(0, 8);
    branch = branchName(sid8, opts.resumeDepth ?? 0);
    worktreePath = join(opts.worktreesRoot, opts.oakridgeSid);
  }

  // Resolve base ref sha for persisting as worktreeBaseRef. When opts.baseRef is
  // provided, rev-parse it against workdir (remote-tracking refs are already
  // fetched there). When omitted, resolveHead gives the sha and doubles as the
  // git worktree base argument.
  let worktreeBaseRef: string;
  let gitBase: string;
  if (opts.baseRef) {
    const revProc = Bun.spawn({
      cmd: ["git", "-C", opts.workdir, "rev-parse", opts.baseRef],
      stdout: "pipe",
      stderr: "pipe",
    });
    const [revOut, revErr, revCode] = await Promise.all([
      new Response(revProc.stdout).text(),
      new Response(revProc.stderr).text(),
      revProc.exited,
    ]);
    if (revCode !== 0) {
      throw new Error(
        `git rev-parse ${opts.baseRef} failed in ${opts.workdir} (exit ${revCode}): ${revErr.trim()}`,
      );
    }
    worktreeBaseRef = revOut.trim();
    gitBase = opts.baseRef;
  } else {
    worktreeBaseRef = await resolveHead(opts.workdir);
    gitBase = worktreeBaseRef;
  }

  const args = [
    "-C",
    opts.workdir,
    "worktree",
    "add",
    // --no-track: kbbl/<sid8> branches are local-only session ephemera, never
    // pushed to a remote, so suppressing upstream tracking avoids polluting
    // `git branch -vv` and prevents an accidental push to origin. Cohort
    // branches (identity provided) omit this flag so they can push naturally.
    ...(opts.identity ? [] : ["--no-track"]),
    "-b",
    branch,
    worktreePath,
    gitBase,
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
  return { worktreePath, worktreeBranch: branch, worktreeBaseRef };
}

/**
 * Best-effort removal: `git worktree remove --force` then `git branch -D`.
 * Errors are swallowed-and-logged rather than thrown, because the caller
 * (DELETE handler, end-of-session reaper) has already committed to its
 * primary action — the JSONL unlink succeeded — and a leftover worktree is
 * recoverable manually or via the Phase 2 reconcile pass.
 *
 * Branch removal runs unconditionally — even if `git worktree remove`
 * failed — so a manually-pruned worktree dir doesn't leak the
 * `kbbl/<sid>` branch behind. Returns true iff `git worktree remove`
 * itself succeeded (the orphan-prevention contract); branch cleanup
 * status is logged but not surfaced.
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
  const wtRemoved = wtCode === 0;
  if (!wtRemoved) {
    console.error(
      `kbbl: git worktree remove ${opts.worktreePath} failed: ${wtStderr.trim()}`,
    );
  }
  // Branch removal runs regardless: a worktree-remove failure is most
  // commonly "the dir was already manually pruned," in which case the
  // branch is the only state still tying us to the kbbl-managed history
  // and would otherwise leak forever. -D is force, so a checked-out
  // branch that's no longer a worktree still gets cleaned.
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
  return wtRemoved;
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
