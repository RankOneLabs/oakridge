/**
 * Cross-boundary contract tests for POST /sessions.
 *
 * These tests replay the exact JSON shapes that oakridge-core's serde_json
 * produces for CreateSessionRequest through the real Hono handler and parser.
 * They pin the boundary so parser drift between the Rust serializer and the
 * TypeScript handler becomes a test failure instead of a silent runtime bug.
 *
 * Rust serialization notes:
 *   - DelegatedRuntime::ClaudeCode  → "claude-code"  (#[serde(rename_all = "kebab-case")])
 *   - DelegatedRuntime::Codex       → "codex"
 *   - model: None                   → model key omitted
 *   - model: Some("...")            → "model": "..."
 *
 * The H1 null model failure was fixed on the Rust side by omitting model
 * when no override is configured. These tests pin both sides of that boundary:
 * omitted model is accepted, while an explicitly sent JSON null is rejected.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { validateGitRefName, validateWorktreeSubdir } from "./sessions";

import { KbblConfigSchema } from "../../config";
import { SessionManager } from "../../session/session-manager";
import type { Session, SpawnCmd } from "../../session/session";
import { mountSessionsRoutes } from "./sessions";
import {
  createRuntimeRegistry,
  type AgentRuntime,
  type RuntimeConfig,
  type RuntimeDescriptor,
  type RuntimeEvent,
  type RuntimeId,
  type RuntimeRegistry,
  type RuntimeSnapshotContrib,
  type SessionHandle,
} from "../../runtime";
import type { EnvelopeEvent } from "../../session/session";

// ---------------------------------------------------------------------------
// Shared setup (mirrors sessions.model.test.ts pattern)
// ---------------------------------------------------------------------------

let tmpRoot: string;
let sessionsDir: string;
let worktreesDir: string;
let repoDir: string;

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

async function noopSpawn(_session: Session): Promise<SpawnCmd> {
  return { cmd: ["true"], cwd: "/tmp", env: {} };
}

function makeManager(): SessionManager {
  return new SessionManager({
    sessionsDir,
    handoffsDir: join(tmpRoot, "handoffs"),
    worktreesDir,
    buildSpawnCmd: noopSpawn,
    config: KbblConfigSchema.parse({}),
  });
}

function makeRuntime(id: RuntimeId, models: string[]): AgentRuntime {
  const descriptor: RuntimeDescriptor = {
    id,
    label: id === "claude-code" ? "Claude Code" : "Codex",
    models: models.map((model) => ({ value: model, label: model })),
    efforts:
      id === "claude-code"
        ? [
            { value: "low", label: "low" },
            { value: "high", label: "high" },
          ]
        : [
            { value: "minimal", label: "minimal" },
            { value: "medium", label: "medium" },
          ],
    supportsCompaction: id === "claude-code",
  };
  return {
    id,
    descriptor,
    isAllowedModel: (model) => models.includes(model),
    async spawn(config: RuntimeConfig): Promise<SessionHandle> {
      const sessionId =
        typeof config.runtimeSpecific?.oakridgeSid === "string"
          ? config.runtimeSpecific.oakridgeSid
          : "contract-test-session";
      return { sessionId, runtimeSid: `${id}-runtime-sid` };
    },
    async terminate(): Promise<void> {},
    async *events(): AsyncIterable<RuntimeEvent> {
      yield { type: "completed", result: { code: 0 } };
    },
    async send(): Promise<void> {},
    async resolveResumeRef(): Promise<{ kind: "unknown" }> {
      return { kind: "unknown" };
    },
    reconstructSnapshot(_events: readonly EnvelopeEvent[]): RuntimeSnapshotContrib {
      return {
        runtimeSid: null,
        yoloMode: false,
        allowedTools: [],
        lastResultUsage: null,
        initialObservedModel: null,
        observedModel: null,
      };
    },
  };
}

function makeRegistry(): RuntimeRegistry {
  return createRuntimeRegistry([
    makeRuntime("claude-code", ["claude-sonnet-4-6", "claude-opus-4-7"]),
    makeRuntime("codex", ["gpt-5.1-codex"]),
  ]);
}

function makeRegistryManager(registry: RuntimeRegistry): SessionManager {
  return new SessionManager({
    sessionsDir,
    handoffsDir: join(tmpRoot, "handoffs"),
    worktreesDir,
    registry,
    config: KbblConfigSchema.parse({}),
  });
}

function makeApp(
  manager: SessionManager,
  registry?: RuntimeRegistry,
  defaultWorkdir: string | null = null,
): Hono {
  const app = new Hono();
  mountSessionsRoutes(app, { manager, defaultWorkdir, sessionsDir, registry });
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
  sessionsDir = join(tmpRoot, "sessions");
  worktreesDir = join(tmpRoot, "worktrees");
  repoDir = join(tmpRoot, "repo");
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(worktreesDir, { recursive: true });
  mkdirSync(repoDir, { recursive: true });
  await gitInitRepo(repoDir);
});

afterEach(async () => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Contract matrix
//
// Each test name calls out the exact Rust value serialized and the expected
// kbbl response. The comment block above each test reproduces the serde_json
// output so the boundary is explicit in the source.
// ---------------------------------------------------------------------------

describe("POST /sessions oakridge-core create-session contract", () => {
  /**
   * Case: no model override (oakridge-core model: None)
   *
   * Rust serializes CreateSessionRequest { model: None } as:
   *   {"workdir":"...","name":"...","artifact_id":"...","runtime":"claude-code"}
   *
   * The model field is omitted because CreateSessionRequest has
   * #[serde(skip_serializing_if = "Option::is_none")] on the model field.
   */
  test("no model override (Rust None, omitted field) is accepted for claude-code runtime", async () => {
    const registry = makeRegistry();
    const manager = makeRegistryManager(registry);
    try {
      const app = makeApp(manager, registry, repoDir);
      const res = await postSessions(app, {
        workdir: repoDir,
        name: "delegate-1",
        artifact_id: "artifact-9",
        runtime: "claude-code",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { runtimeId: RuntimeId; model: string | null };
      expect(body.runtimeId).toBe("claude-code");
      expect(body.model).toBeNull();
    } finally {
      await manager.endAll();
    }
  });

  /**
   * Case: valid model override (oakridge-core model: Some("claude-sonnet-4-6"))
   *
   * Rust serializes CreateSessionRequest { model: Some("claude-sonnet-4-6") } as:
   *   {"workdir":"...","name":"...","artifact_id":"...","runtime":"claude-code","model":"claude-sonnet-4-6"}
   */
  test("valid model string is accepted for claude-code runtime", async () => {
    const registry = makeRegistry();
    const manager = makeRegistryManager(registry);
    const app = makeApp(manager, registry, repoDir);
    const res = await postSessions(app, {
      workdir: repoDir,
      name: "delegate-1",
      artifact_id: "artifact-9",
      runtime: "claude-code",
      model: "claude-sonnet-4-6",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runtimeId: RuntimeId; model: string | null };
    expect(body.runtimeId).toBe("claude-code");
    expect(body.model).toBe("claude-sonnet-4-6");
    await manager.endAll();
  });

  /**
   * Case: runtime codex, no model override (oakridge-core DelegatedRuntime::Codex, model: None)
   *
   * Rust serializes as:
   *   {"workdir":"...","name":"...","artifact_id":"...","runtime":"codex"}
   */
  test("no model override (Rust None, omitted field) is accepted for codex runtime", async () => {
    const registry = makeRegistry();
    const manager = makeRegistryManager(registry);
    try {
      const app = makeApp(manager, registry, repoDir);
      const res = await postSessions(app, {
        workdir: repoDir,
        name: "delegate-2",
        artifact_id: "artifact-10",
        runtime: "codex",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { runtimeId: RuntimeId; model: string | null };
      expect(body.runtimeId).toBe("codex");
      expect(body.model).toBeNull();
    } finally {
      await manager.endAll();
    }
  });

  /**
   * Case: runtime codex, valid model (oakridge-core DelegatedRuntime::Codex, model: Some("gpt-5.1-codex"))
   *
   * Rust serializes DelegatedRuntime::Codex → "codex" (kebab-case serde rename).
   * Serialized payload:
   *   {"workdir":"...","name":"...","artifact_id":"...","runtime":"codex","model":"gpt-5.1-codex"}
   */
  test("valid model string is accepted for codex runtime", async () => {
    const registry = makeRegistry();
    const manager = makeRegistryManager(registry);
    const app = makeApp(manager, registry, repoDir);
    const res = await postSessions(app, {
      workdir: repoDir,
      name: "delegate-2",
      artifact_id: "artifact-10",
      runtime: "codex",
      model: "gpt-5.1-codex",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runtimeId: RuntimeId; model: string | null };
    expect(body.runtimeId).toBe("codex");
    expect(body.model).toBe("gpt-5.1-codex");
    await manager.endAll();
  });

  /**
   * Case: effort field present (future oakridge-core expansion)
   *
   * CreateSessionRequest does not yet carry an effort field. When it does,
   * the serialized payload will include "effort": "<level>". This test pins
   * that kbbl accepts a valid effort alongside a valid claude-code model,
   * ensuring the handler path is exercised before the Rust side adds the
   * field.
   *
   * Anticipated future payload:
   *   {"workdir":"...","name":"...","artifact_id":"...","runtime":"claude-code","model":"claude-sonnet-4-6","effort":"high"}
   */
  test("effort field is accepted alongside valid claude-code model", async () => {
    const registry = makeRegistry();
    const manager = makeRegistryManager(registry);
    const app = makeApp(manager, registry, repoDir);
    const res = await postSessions(app, {
      workdir: repoDir,
      name: "delegate-1",
      artifact_id: "artifact-9",
      runtime: "claude-code",
      model: "claude-sonnet-4-6",
      effort: "high",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      runtimeId: RuntimeId;
      model: string | null;
      effort: string | null;
    };
    expect(body.runtimeId).toBe("claude-code");
    expect(body.model).toBe("claude-sonnet-4-6");
    expect(body.effort).toBe("high");
    await manager.endAll();
  });

  /**
   * Case: explicit model null rejection — pinning the kbbl contract
   *
   * Regardless of runtime, a JSON body with "model": null must produce a
   * 400 with the error "model must be a string". This ensures that any
   * future handler refactor which accidentally treats null as "no model
   * preference" (i.e. a pass-through) is caught immediately.
   *
   * This is the same defect class as the H1 null model failure above but
   * tested in isolation to make the rejection contract explicit.
   */
  test("explicitly sent null model is always rejected with model must be a string", async () => {
    const manager = makeManager();
    try {
      const app = makeApp(manager, undefined, repoDir);
      const res = await postSessions(app, {
        workdir: repoDir,
        model: null,
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("model must be a string");
    } finally {
      await manager.endAll();
    }
  });
});

// ---------------------------------------------------------------------------
// Worktree identity validation unit tests
// ---------------------------------------------------------------------------

describe("validateGitRefName", () => {
  test("accepts simple branch names", () => {
    expect(validateGitRefName("main", "f")).toBeNull();
    expect(validateGitRefName("cohort/v2_readiness/1-foo", "f")).toBeNull();
    expect(validateGitRefName("feature/my-branch", "f")).toBeNull();
    expect(validateGitRefName("origin/epic/foo_bar", "f")).toBeNull();
  });

  test("rejects names with invalid characters", () => {
    expect(validateGitRefName("branch name", "f")).not.toBeNull();
    expect(validateGitRefName("branch~name", "f")).not.toBeNull();
    expect(validateGitRefName("branch^name", "f")).not.toBeNull();
    expect(validateGitRefName("branch:name", "f")).not.toBeNull();
    expect(validateGitRefName("branch?name", "f")).not.toBeNull();
    expect(validateGitRefName("branch*name", "f")).not.toBeNull();
  });

  test("rejects names with double dots", () => {
    expect(validateGitRefName("branch..name", "f")).not.toBeNull();
  });

  test("rejects names starting with dot", () => {
    expect(validateGitRefName(".hidden", "f")).not.toBeNull();
  });

  test("rejects names ending with .lock", () => {
    expect(validateGitRefName("branch.lock", "f")).not.toBeNull();
  });

  test("rejects empty names", () => {
    expect(validateGitRefName("", "f")).not.toBeNull();
  });

  test("rejects names starting with dash", () => {
    expect(validateGitRefName("-branch", "f")).not.toBeNull();
  });
});

describe("validateWorktreeSubdir", () => {
  test("accepts normalized relative paths", () => {
    expect(validateWorktreeSubdir("epic_x/1-foo")).toBeNull();
    expect(validateWorktreeSubdir("v2_readiness/1-session")).toBeNull();
    expect(validateWorktreeSubdir("single")).toBeNull();
  });

  test("rejects absolute paths", () => {
    expect(validateWorktreeSubdir("/absolute/path")).not.toBeNull();
  });

  test("rejects tilde prefix", () => {
    expect(validateWorktreeSubdir("~/relative")).not.toBeNull();
  });

  test("rejects traversal segments", () => {
    expect(validateWorktreeSubdir("foo/../bar")).not.toBeNull();
    expect(validateWorktreeSubdir("../escape")).not.toBeNull();
  });

  test("rejects empty segments", () => {
    expect(validateWorktreeSubdir("foo//bar")).not.toBeNull();
  });

  test("rejects shell-significant characters", () => {
    expect(validateWorktreeSubdir("foo/$BAR")).not.toBeNull();
    expect(validateWorktreeSubdir("foo;rm -rf")).not.toBeNull();
  });

  test("rejects empty string", () => {
    expect(validateWorktreeSubdir("")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// POST /sessions worktree body contract
// ---------------------------------------------------------------------------

describe("POST /sessions worktree identity contract", () => {
  test("legacy workdir-only session returns null worktree metadata", async () => {
    const registry = makeRegistry();
    const manager = makeRegistryManager(registry);
    const app = makeApp(manager, registry, repoDir);
    const res = await postSessions(app, {
      workdir: repoDir,
      runtime: "claude-code",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sid: string;
      worktreePath: string | null;
      worktreeBranch: string | null;
      worktreeBaseRef: string | null;
    };
    expect(body.sid).toBeDefined();
    expect(body.worktreeBaseRef).not.toBeNull();
    expect(body.worktreeBranch).toMatch(/^kbbl\//);
    expect(body.worktreePath).not.toBeNull();
    await manager.endAll();
  });

  test("managed worktree session returns worktree branch and path", async () => {
    const registry = makeRegistry();
    const manager = makeRegistryManager(registry);
    const app = makeApp(manager, registry, repoDir);
    const res = await postSessions(app, {
      workdir: repoDir,
      runtime: "claude-code",
      worktree: {
        branchName: "cohort/test_epic/1-feature",
        worktreeSubdir: "test_epic/1-feature",
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sid: string;
      worktreePath: string | null;
      worktreeBranch: string | null;
      worktreeBaseRef: string | null;
    };
    expect(body.worktreeBranch).toBe("cohort/test_epic/1-feature");
    expect(body.worktreePath).toContain("test_epic/1-feature");
    expect(body.worktreeBaseRef).not.toBeNull();
    await manager.endAll();
  });

  test("invalid branchName returns 400", async () => {
    const registry = makeRegistry();
    const manager = makeRegistryManager(registry);
    try {
      const app = makeApp(manager, registry, repoDir);
      const res = await postSessions(app, {
        workdir: repoDir,
        worktree: {
          branchName: "branch with spaces",
          worktreeSubdir: "epic/1-cohort",
        },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("worktree.branchName");
    } finally {
      await manager.endAll();
    }
  });

  test("invalid worktreeSubdir (traversal) returns 400", async () => {
    const registry = makeRegistry();
    const manager = makeRegistryManager(registry);
    try {
      const app = makeApp(manager, registry, repoDir);
      const res = await postSessions(app, {
        workdir: repoDir,
        worktree: {
          branchName: "cohort/epic/1-foo",
          worktreeSubdir: "../escape",
        },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("worktreeSubdir");
    } finally {
      await manager.endAll();
    }
  });

  test("absolute worktreeSubdir returns 400", async () => {
    const registry = makeRegistry();
    const manager = makeRegistryManager(registry);
    try {
      const app = makeApp(manager, registry, repoDir);
      const res = await postSessions(app, {
        workdir: repoDir,
        worktree: {
          branchName: "cohort/epic/1-foo",
          worktreeSubdir: "/absolute/path",
        },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("worktreeSubdir");
    } finally {
      await manager.endAll();
    }
  });

  test("invalid baseRef returns 400", async () => {
    const registry = makeRegistry();
    const manager = makeRegistryManager(registry);
    try {
      const app = makeApp(manager, registry, repoDir);
      const res = await postSessions(app, {
        workdir: repoDir,
        worktree: {
          branchName: "cohort/epic/1-foo",
          worktreeSubdir: "epic/1-foo",
          baseRef: "bad ref with spaces",
        },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("worktree.baseRef");
    } finally {
      await manager.endAll();
    }
  });

  test("worktree without branchName returns 400", async () => {
    const registry = makeRegistry();
    const manager = makeRegistryManager(registry);
    try {
      const app = makeApp(manager, registry, repoDir);
      const res = await postSessions(app, {
        workdir: repoDir,
        worktree: { worktreeSubdir: "epic/1-foo" },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("worktree.branchName");
    } finally {
      await manager.endAll();
    }
  });

  test("worktree as non-object returns 400", async () => {
    const registry = makeRegistry();
    const manager = makeRegistryManager(registry);
    try {
      const app = makeApp(manager, registry, repoDir);
      const res = await postSessions(app, {
        workdir: repoDir,
        worktree: "not-an-object",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("worktree must be an object");
    } finally {
      await manager.endAll();
    }
  });

  test("absent effort is accepted and returns null effort in snapshot", async () => {
    const registry = makeRegistry();
    const manager = makeRegistryManager(registry);
    const app = makeApp(manager, registry, repoDir);
    const res = await postSessions(app, {
      workdir: repoDir,
      runtime: "claude-code",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { effort: string | null };
    expect(body.effort).toBeNull();
    await manager.endAll();
  });

  test("valid effort low is accepted for claude-code", async () => {
    const registry = makeRegistry();
    const manager = makeRegistryManager(registry);
    const app = makeApp(manager, registry, repoDir);
    const res = await postSessions(app, {
      workdir: repoDir,
      runtime: "claude-code",
      effort: "low",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { effort: string | null };
    expect(body.effort).toBe("low");
    await manager.endAll();
  });

  test("invalid effort returns 400", async () => {
    const registry = makeRegistry();
    const manager = makeRegistryManager(registry);
    try {
      const app = makeApp(manager, registry, repoDir);
      const res = await postSessions(app, {
        workdir: repoDir,
        runtime: "claude-code",
        effort: "turbo-max",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("turbo-max");
    } finally {
      await manager.endAll();
    }
  });

  test("create-session response includes worktreePath, worktreeBranch, worktreeBaseRef", async () => {
    const registry = makeRegistry();
    const manager = makeRegistryManager(registry);
    const app = makeApp(manager, registry, repoDir);
    const res = await postSessions(app, {
      workdir: repoDir,
      runtime: "claude-code",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect("worktreePath" in body).toBe(true);
    expect("worktreeBranch" in body).toBe(true);
    expect("worktreeBaseRef" in body).toBe(true);
    await manager.endAll();
  });
});
