/**
 * Why a session could not be started must reach the caller.
 *
 * A worktree that cannot be created is the caller's request being
 * unsatisfiable — a base ref that does not exist, a branch already taken — not
 * kbbl being unavailable. It was once reported as a bare 503 with git's
 * complaint left in a server log, so a run that failed at `build` gave its
 * operator `{"error":"failed to ensure resumable session"}` and nothing else.
 * These tests pin the route-level mapping from ACP failure codes to the HTTP
 * statuses the DBOS adapter and operators read.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

import { mountSessionsRoutes } from "./sessions";
import type { SessionManager } from "../../session/session-manager";
import type { AcpSessionService } from "../../acp/session-service";
import { acpError, err, type AcpFailureCode } from "../../acp/types";

let repoDir: string;

const git = async (cwd: string, ...args: string[]): Promise<void> => {
  const proc = Bun.spawn({ cmd: ["git", "-C", cwd, ...args], stdout: "ignore", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
};

// The route validates that the workdir exists before it ever reaches the
// service, so the failures under test need a real directory to reach.
beforeAll(async () => {
  repoDir = mkdtempSync(join(tmpdir(), "kbbl-ensure-test-"));
  await git(repoDir, "init", "-q", "-b", "main");
  await git(repoDir, "config", "user.email", "test@example.com");
  await git(repoDir, "config", "user.name", "test");
  await git(repoDir, "config", "commit.gpgsign", "false");
  await git(repoDir, "config", "tag.gpgsign", "false");
  await git(repoDir, "commit", "--allow-empty", "-m", "init");
});

afterAll(() => rmSync(repoDir, { recursive: true, force: true }));

const ensureAgainst = async (code: AcpFailureCode, detail: string) => {
  const acp = {
    ensureResumableSession: async () =>
      err(acpError(code, "service.ensureResumableSession", detail)),
  } as unknown as AcpSessionService;
  const app = new Hono();
  mountSessionsRoutes(app, {
    acp,
    manager: {} as unknown as SessionManager,
    defaultWorkdir: repoDir,
  });
  return app.fetch(new Request("http://kbbl/sessions/resumable/build-1", {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ initial_prompt: "build it", workdir: repoDir, runtime: "claude-code",
      worktree: { branch_name: "cohort/x", worktree_subdir: "x", base_ref: "epic/tiers-page" } }),
  }));
};

test("a worktree failure carries git's own reason", async () => {
  const response = await ensureAgainst("worktree_failed", "fatal: invalid reference: epic/tiers-page");
  expect(response.status).toBe(422);
  expect(await response.json()).toEqual(expect.objectContaining({
    code: "worktree_create_failed", detail: "fatal: invalid reference: epic/tiers-page",
  }));
});

/** An unsatisfiable request is the caller's to fix, not a kbbl outage. */
test("a worktree failure is not reported as kbbl being unavailable", async () => {
  const response = await ensureAgainst("worktree_failed", "fatal: a branch named 'cohort/x' already exists");
  expect(response.status).not.toBe(503);
  expect((await response.json() as { detail: string }).detail).toContain("already exists");
});

test("the failures that already had a reading keep it", async () => {
  expect((await ensureAgainst("session_key_conflict", "claimed with a different start spec")).status).toBe(409);
  expect((await ensureAgainst("agent_profile_unavailable", 'no ACP agent profile named "nope"')).status).toBe(400);
});

/** Runtime-side provisioning failures surface with their ACP code intact. */
test("a spawn/initialize failure is a 503 that names its ACP failure code", async () => {
  const response = await ensureAgainst("agent_spawn_failed", 'spawn of "claude-agent-acp" produced no pid/stdio');
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual(expect.objectContaining({ code: "agent_spawn_failed" }));
});
