/**
 * Contract tests for POST /sessions over the ACP backend.
 *
 * These replay the exact JSON shapes callers produce (the PWA, responders,
 * and historical oakridge-core serde output) through the real Hono handler,
 * the real AcpSessionService, the real git worktree provider, and a real
 * fake-agent child. Model/effort strings are no longer statically
 * allowlisted (§12): acceptance means the agent's own config options
 * resolved them, so the accepted cases use the fake agent's model ids.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { validateGitRefName, validateWorktreeSubdir } from "./sessions";

import { mountSessionsRoutes } from "./sessions";
import { makeAcpTestService, type AcpTestHarness } from "../../acp/test-harness";
import type { SessionManager } from "../../session/session-manager";

let tmpRoot: string;
let repoDir: string;
let harness: AcpTestHarness;

async function gitInitRepo(dir: string): Promise<void> {
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
    const [stderr, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
    if (code !== 0) throw new Error(`${cmd.join(" ")} failed (exit ${code}): ${stderr}`);
  }
}

/** The read-only legacy manager slice these routes still consult. */
const stubManager = {
  listSnapshots: () => [],
  listArchivedSnapshots: async () => [],
  listByArtifact: () => [],
  remove: async () => false,
} as unknown as SessionManager;

function makeApp(defaultWorkdir: string | null = null): Hono {
  const app = new Hono();
  mountSessionsRoutes(app, {
    acp: harness.service,
    manager: stubManager,
    defaultWorkdir,
  });
  return app;
}

async function postSessions(app: Hono, body: unknown): Promise<Response> {
  return app.request("/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kbbl-contract-test-"));
  repoDir = join(tmpRoot, "repo");
  await mkdir(join(tmpRoot, "worktrees"), { recursive: true });
  await mkdir(join(tmpRoot, "state"), { recursive: true });
  mkdirSync(repoDir, { recursive: true });
  await gitInitRepo(repoDir);
  harness = makeAcpTestService({
    stateDir: join(tmpRoot, "state"),
    worktreesRoot: join(tmpRoot, "worktrees"),
  });
});

afterEach(async () => {
  await harness.service.shutdown();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("POST /sessions create-session contract", () => {
  test("no model override (omitted field) is accepted; snapshot model is null", async () => {
    const app = makeApp(repoDir);
    const res = await postSessions(app, {
      workdir: repoDir,
      name: "delegate-1",
      artifact_id: "artifact-9",
      runtime: "claude-code",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agentProfile: string; requestedModel: string | null };
    expect(body.agentProfile).toBe("claude-code");
    expect(body.requestedModel).toBeNull();
  });

  test("a model the agent's config options resolve is accepted and recorded", async () => {
    const app = makeApp(repoDir);
    const res = await postSessions(app, {
      workdir: repoDir,
      runtime: "claude-code",
      model: "fake-small",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { requestedModel: string | null };
    expect(body.requestedModel).toBe("fake-small");
  });

  test("a model the agent does not expose is refused with the ACP failure code", async () => {
    const app = makeApp(repoDir);
    const res = await postSessions(app, {
      workdir: repoDir,
      runtime: "claude-code",
      model: "gpt-nonexistent",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(
      expect.objectContaining({ code: "requested_model_unsupported" }),
    );
  });

  test("explicitly sent null model is always rejected with model must be a string", async () => {
    const app = makeApp(repoDir);
    const res = await postSessions(app, {
      workdir: repoDir,
      runtime: "claude-code",
      model: null,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/model must be a non-empty string/);
  });

  test("unknown runtime is refused as an unavailable agent profile", async () => {
    const app = makeApp(repoDir);
    const res = await postSessions(app, { workdir: repoDir, runtime: "gemini" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(
      expect.objectContaining({ code: "agent_profile_unavailable" }),
    );
  });

  test("agent_profile is accepted as the preferred alias for runtime (§14.2)", async () => {
    const app = makeApp(repoDir);
    const res = await postSessions(app, { workdir: repoDir, agent_profile: "codex" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { agentProfile: string }).agentProfile).toBe("codex");
  });

  test("conflicting runtime and agent_profile are rejected", async () => {
    const app = makeApp(repoDir);
    const res = await postSessions(app, {
      workdir: repoDir,
      runtime: "claude-code",
      agent_profile: "codex",
    });
    expect(res.status).toBe(400);
  });

  test("an effort the agent's thought_level option resolves is accepted", async () => {
    const app = makeApp(repoDir);
    const res = await postSessions(app, {
      workdir: repoDir,
      runtime: "claude-code",
      model: "fake-small",
      effort: "low",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { requestedEffort: string | null }).requestedEffort).toBe("low");
  });

  test("an effort the agent does not expose is refused with the ACP failure code", async () => {
    const app = makeApp(repoDir);
    const res = await postSessions(app, {
      workdir: repoDir,
      runtime: "claude-code",
      effort: "xhigh",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(
      expect.objectContaining({ code: "requested_effort_unsupported" }),
    );
  });

  test("fresh session without workdir and no configured default is rejected", async () => {
    const app = makeApp(null);
    const res = await postSessions(app, { runtime: "claude-code" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("workdir is required");
  });
});

// ---------------------------------------------------------------------------
// Pure validators (unchanged contract)
// ---------------------------------------------------------------------------

describe("validateGitRefName", () => {
  test("accepts simple branch names", () => {
    expect(validateGitRefName("cohort/epic/1-foo", "branchName")).toBeNull();
    expect(validateGitRefName("main", "branchName")).toBeNull();
    expect(validateGitRefName("feature-x_y.z", "branchName")).toBeNull();
  });

  test("rejects names with invalid characters", () => {
    expect(validateGitRefName("has space", "branchName")).not.toBeNull();
    expect(validateGitRefName("has~tilde", "branchName")).not.toBeNull();
    expect(validateGitRefName("has^caret", "branchName")).not.toBeNull();
    expect(validateGitRefName("has:colon", "branchName")).not.toBeNull();
    expect(validateGitRefName("has?question", "branchName")).not.toBeNull();
    expect(validateGitRefName("has*star", "branchName")).not.toBeNull();
  });

  test("rejects names with double dots", () => {
    expect(validateGitRefName("a..b", "branchName")).not.toBeNull();
  });

  test("rejects names starting with dot", () => {
    expect(validateGitRefName(".hidden", "branchName")).not.toBeNull();
  });

  test("rejects names ending with .lock", () => {
    expect(validateGitRefName("branch.lock", "branchName")).not.toBeNull();
  });

  test("rejects empty names", () => {
    expect(validateGitRefName("", "branchName")).not.toBeNull();
  });

  test("rejects names starting with dash", () => {
    expect(validateGitRefName("-flag", "branchName")).not.toBeNull();
  });

  test("rejects names starting with '/'", () => {
    expect(validateGitRefName("/abs", "branchName")).not.toBeNull();
  });

  test("rejects names with empty path segments ('//')", () => {
    expect(validateGitRefName("a//b", "branchName")).not.toBeNull();
  });

  test("rejects names whose path components start with '.'", () => {
    expect(validateGitRefName("a/.b", "branchName")).not.toBeNull();
  });
});

describe("validateWorktreeSubdir", () => {
  test("accepts normalized relative paths", () => {
    expect(validateWorktreeSubdir("epic/cohort-1")).toBeNull();
    expect(validateWorktreeSubdir("simple")).toBeNull();
  });

  test("rejects absolute paths", () => {
    expect(validateWorktreeSubdir("/abs/path")).not.toBeNull();
  });

  test("rejects tilde prefix", () => {
    expect(validateWorktreeSubdir("~/home")).not.toBeNull();
  });

  test("rejects traversal segments", () => {
    expect(validateWorktreeSubdir("a/../b")).not.toBeNull();
    expect(validateWorktreeSubdir("..")).not.toBeNull();
  });

  test("rejects empty segments", () => {
    expect(validateWorktreeSubdir("a//b")).not.toBeNull();
  });

  test("rejects shell-significant characters", () => {
    expect(validateWorktreeSubdir("a$(rm)/b")).not.toBeNull();
    expect(validateWorktreeSubdir("a;b")).not.toBeNull();
  });

  test("rejects empty string", () => {
    expect(validateWorktreeSubdir("")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Worktree identity
// ---------------------------------------------------------------------------

describe("POST /sessions worktree identity contract", () => {
  test("workdir-only session returns non-null worktree metadata (kbbl always creates a worktree)", async () => {
    const app = makeApp(repoDir);
    const res = await postSessions(app, { workdir: repoDir, runtime: "claude-code" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      worktreePath: string | null;
      worktreeBranch: string | null;
      worktreeBaseRef: string | null;
    };
    expect(body.worktreePath).not.toBeNull();
    expect(body.worktreePath).not.toBe(repoDir);
    expect(body.worktreeBranch).toMatch(/^kbbl\//);
    expect(body.worktreeBaseRef).toMatch(/^[0-9a-f]{40}$/);
  });

  test("managed worktree session returns worktree branch and path", async () => {
    const app = makeApp(repoDir);
    const res = await postSessions(app, {
      workdir: repoDir,
      runtime: "claude-code",
      worktree: { branchName: "cohort/epic/1-x", worktreeSubdir: "epic/1-x" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { worktreeBranch: string | null; worktreePath: string | null };
    expect(body.worktreeBranch).toBe("cohort/epic/1-x");
    expect(body.worktreePath).toContain(join("worktrees", "epic", "1-x"));
  });

  test("invalid branchName returns 400", async () => {
    const app = makeApp(repoDir);
    const res = await postSessions(app, {
      workdir: repoDir,
      worktree: { branchName: "has space", worktreeSubdir: "x" },
    });
    expect(res.status).toBe(400);
  });

  test("invalid worktreeSubdir (traversal) returns 400", async () => {
    const app = makeApp(repoDir);
    const res = await postSessions(app, {
      workdir: repoDir,
      worktree: { branchName: "cohort/x", worktreeSubdir: "a/../b" },
    });
    expect(res.status).toBe(400);
  });

  test("absolute worktreeSubdir returns 400", async () => {
    const app = makeApp(repoDir);
    const res = await postSessions(app, {
      workdir: repoDir,
      worktree: { branchName: "cohort/x", worktreeSubdir: "/abs" },
    });
    expect(res.status).toBe(400);
  });

  test("invalid baseRef returns 400", async () => {
    const app = makeApp(repoDir);
    const res = await postSessions(app, {
      workdir: repoDir,
      worktree: { branchName: "cohort/x", worktreeSubdir: "x", baseRef: "has space" },
    });
    expect(res.status).toBe(400);
  });

  test("worktree without branchName returns 400", async () => {
    const app = makeApp(repoDir);
    const res = await postSessions(app, {
      workdir: repoDir,
      worktree: { worktreeSubdir: "x" },
    });
    expect(res.status).toBe(400);
  });

  test("worktree as non-object returns 400", async () => {
    const app = makeApp(repoDir);
    const res = await postSessions(app, { workdir: repoDir, worktree: "cohort/x" });
    expect(res.status).toBe(400);
  });

  test("worktree cannot be combined with resume_from", async () => {
    const app = makeApp(repoDir);
    const res = await postSessions(app, {
      workdir: repoDir,
      resume_from: "db26174d-21e2-40f4-af40-fc359c4e9604",
      worktree: { branchName: "cohort/x", worktreeSubdir: "x" },
    });
    expect(res.status).toBe(400);
  });
});
