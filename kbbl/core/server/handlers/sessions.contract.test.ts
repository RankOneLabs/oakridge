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
