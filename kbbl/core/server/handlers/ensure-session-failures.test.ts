/**
 * Why a session could not be started must reach the caller.
 *
 * A worktree that cannot be created is the caller's request being
 * unsatisfiable — a base ref that does not exist, a branch already taken — not
 * kbbl being unavailable. It was reported as a bare 503 with git's complaint
 * left in a server log, so a run that failed at `build` gave its operator
 * `{"error":"failed to ensure resumable session"}` and nothing else. The cause
 * that time was an epic branch nothing had created.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

import { mountSessionsRoutes } from "./sessions";
import type { SessionManager } from "../../session/session-manager";
import { NonGitWorkdirError } from "../../session/session-manager";
import { SessionKeyConflictError, type ResumableSessionKey } from "../../session/resumable-session";
import { WorktreeCreateError } from "../../session/worktree";

let repoDir: string;

const git = async (cwd: string, ...args: string[]): Promise<void> => {
  const proc = Bun.spawn({ cmd: ["git", "-C", cwd, ...args], stdout: "ignore", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
};

// The route validates that the workdir is inside a real repository before it
// ever reaches the manager, so the failures under test need one to reach.
beforeAll(async () => {
  repoDir = mkdtempSync(join(tmpdir(), "kbbl-ensure-test-"));
  await git(repoDir, "init", "-q", "-b", "main");
  await git(repoDir, "config", "user.email", "test@example.com");
  await git(repoDir, "config", "user.name", "test");
  // Disable signing locally — an operator with global commit.gpgsign=true
  // would otherwise see this throwaway repo try (and fail) to sign its init
  // commit. Only affects this tmp repo; never touches user config.
  await git(repoDir, "config", "commit.gpgsign", "false");
  await git(repoDir, "config", "tag.gpgsign", "false");
  await git(repoDir, "commit", "--allow-empty", "-m", "init");
});

afterAll(() => rmSync(repoDir, { recursive: true, force: true }));

const ensureAgainst = async (failure: unknown) => {
  const manager = { ensureResumableSession: async () => { throw failure; } } as unknown as SessionManager;
  const app = new Hono();
  mountSessionsRoutes(app, { manager, defaultWorkdir: repoDir, sessionsDir: repoDir });
  return app.fetch(new Request("http://kbbl/sessions/resumable/build-1", {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ initial_prompt: "build it", workdir: repoDir, runtime: "claude-code",
      worktree: { branch_name: "cohort/x", worktree_subdir: "x", base_ref: "epic/tiers-page" } }),
  }));
};

test("a worktree failure carries git's own reason", async () => {
  const response = await ensureAgainst(new WorktreeCreateError("git worktree add failed", "Preparing worktree\nfatal: invalid reference: epic/tiers-page\n"));
  expect(response.status).toBe(422);
  expect(await response.json()).toEqual(expect.objectContaining({
    code: "worktree_create_failed", detail: "fatal: invalid reference: epic/tiers-page",
  }));
});

/** An unsatisfiable request is the caller's to fix, not a kbbl outage. */
test("a worktree failure is not reported as kbbl being unavailable", async () => {
  const response = await ensureAgainst(new WorktreeCreateError("git worktree add failed", "fatal: a branch named 'cohort/x' already exists\n"));
  expect(response.status).not.toBe(503);
  expect((await response.json() as { detail: string }).detail).toContain("already exists");
});

test("the failures that already had a reading keep it", async () => {
  expect((await ensureAgainst(new SessionKeyConflictError("build-1" as ResumableSessionKey))).status).toBe(409);
  expect((await ensureAgainst(new NonGitWorkdirError("workdir is not a git repository"))).status).toBe(400);
});

/** Anything unrecognised stays a 503 with nothing leaked from the exception. */
test("an unrecognised failure is still an opaque 503", async () => {
  const response = await ensureAgainst(new Error("connection to sqlite lost at /secret/path.db"));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "failed to ensure resumable session" });
});

/**
 * The path git names is kbbl's own worktrees root, not anything the caller
 * supplied, and this server binds beyond loopback — so it must not reach the
 * wire. Pinned here as well as at the transform, because the leak would be an
 * HTTP response, not a return value.
 */
test("a worktree failure detail discloses no server filesystem layout", async () => {
  const response = await ensureAgainst(new WorktreeCreateError(
    "git worktree add failed",
    "fatal: '/var/lib/kbbl/data/worktrees/f5aeeb42/spec' already exists\n",
  ));
  const body = await response.json() as { readonly detail: string };
  expect(body.detail).toBe("fatal: '<path>' already exists");
  expect(JSON.stringify(body)).not.toContain("/var/lib");
});
