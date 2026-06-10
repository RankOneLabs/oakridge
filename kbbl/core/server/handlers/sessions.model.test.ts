import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

import { KbblConfigSchema } from "../../config";
import { SessionManager } from "../../session/session-manager";
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
import { mountSessionsRoutes } from "./sessions";

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

function makeRuntime(id: RuntimeId, models: string[]): AgentRuntime {
  const descriptor: RuntimeDescriptor = {
    id,
    label: id === "claude-code" ? "Claude Code" : "Codex",
    models: models.map((model) => ({ value: model, label: model })),
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
          : "fake-session";
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

function makeRegistry(defaultId: RuntimeId = "claude-code"): RuntimeRegistry {
  return createRuntimeRegistry([
    makeRuntime("claude-code", ["claude-sonnet-4-6", "claude-opus-4-7"]),
    makeRuntime("codex", ["gpt-5.1-codex"]),
  ], defaultId);
}

/**
 * Like makeRegistry, but its runtimes keep the session live: events() pends
 * until terminate() is called, so a created session stays live across calls
 * (the default makeRuntime yields "completed" immediately and ends at once).
 * terminate() releases the pend so endAll() cleanup still completes.
 */
function makeLiveRegistry(): RuntimeRegistry {
  const live = (id: RuntimeId, models: string[]): AgentRuntime => {
    let release = () => {};
    const stopped = new Promise<void>((r) => {
      release = r;
    });
    return {
      ...makeRuntime(id, models),
      async terminate(): Promise<void> {
        release();
      },
      async *events(): AsyncIterable<RuntimeEvent> {
        await stopped;
        yield { type: "completed", result: { code: 0 } };
      },
    };
  };
  return createRuntimeRegistry([
    live("claude-code", ["claude-sonnet-4-6", "claude-opus-4-7"]),
    live("codex", ["gpt-5.1-codex"]),
  ], "claude-code");
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
  mountSessionsRoutes(app, {
    manager,
    defaultWorkdir,
    registry,
  });
  return app;
}

/** Minimal valid C.1 body, using repoDir for workdir. */
function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    backend: "claude-code",
    prompt: "implement the feature",
    workdir: repoDir,
    pre_authorized_tools: [],
    yolo: false,
    output_slots: [],
    callback: {
      base_url: "http://oakridge:3000",
      stage_instance_id: "stage-abc",
      emit_path: "/emit",
      status_path: "/status",
    },
    ...overrides,
  };
}

async function postSessions(
  app: Hono,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request("/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kbbl-model-test-"));
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

describe("POST /sessions — C.1 contract validation", () => {
  test("rejects request with no body", async () => {
    const registry = makeRegistry();
    const manager = makeRegistryManager(registry);
    const app = makeApp(manager, registry, repoDir);
    const res = await app.request("/sessions", { method: "POST" });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("json body is required");
    await manager.endAll();
  });

  test("rejects non-object body", async () => {
    const registry = makeRegistry();
    const manager = makeRegistryManager(registry);
    const app = makeApp(manager, registry, repoDir);
    const res = await app.request("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([1, 2, 3]),
    });
    expect(res.status).toBe(400);
    await manager.endAll();
  });

  test("rejects missing backend", async () => {
    const registry = makeRegistry();
    const manager = makeRegistryManager(registry);
    const app = makeApp(manager, registry, repoDir);
    const { backend: _b, ...rest } = validBody();
    const res = await postSessions(app, rest);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("backend is required");
    await manager.endAll();
  });

  test("rejects unknown backend", async () => {
    const registry = makeRegistry();
    const manager = makeRegistryManager(registry);
    const app = makeApp(manager, registry, repoDir);
    const res = await postSessions(app, validBody({ backend: "gpt" }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("unknown backend: gpt");
    await manager.endAll();
  });

  test("rejects missing prompt", async () => {
    const registry = makeRegistry();
    const manager = makeRegistryManager(registry);
    const app = makeApp(manager, registry, repoDir);
    const { prompt: _p, ...rest } = validBody();
    const res = await postSessions(app, rest);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("prompt is required");
    await manager.endAll();
  });

  test("rejects empty prompt", async () => {
    const registry = makeRegistry();
    const manager = makeRegistryManager(registry);
    const app = makeApp(manager, registry, repoDir);
    const res = await postSessions(app, validBody({ prompt: "   " }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("prompt must be non-empty");
    await manager.endAll();
  });

  test("rejects missing workdir when no server default", async () => {
    const registry = makeRegistry();
    const manager = makeRegistryManager(registry);
    const app = makeApp(manager, registry, null);
    const { workdir: _w, ...rest } = validBody();
    const res = await postSessions(app, rest);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("workdir is required");
    await manager.endAll();
  });

  test("rejects missing pre_authorized_tools", async () => {
    const registry = makeRegistry();
    const manager = makeRegistryManager(registry);
    const app = makeApp(manager, registry, repoDir);
    const { pre_authorized_tools: _t, ...rest } = validBody();
    const res = await postSessions(app, rest);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("pre_authorized_tools is required");
    await manager.endAll();
  });

  test("rejects non-array pre_authorized_tools", async () => {
    const registry = makeRegistry();
    const manager = makeRegistryManager(registry);
    const app = makeApp(manager, registry, repoDir);
    const res = await postSessions(app, validBody({ pre_authorized_tools: "Bash" }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("pre_authorized_tools must be an array");
    await manager.endAll();
  });

  test("rejects missing yolo", async () => {
    const registry = makeRegistry();
    const manager = makeRegistryManager(registry);
    const app = makeApp(manager, registry, repoDir);
    const { yolo: _y, ...rest } = validBody();
    const res = await postSessions(app, rest);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("yolo is required");
    await manager.endAll();
  });

  test("rejects non-boolean yolo", async () => {
    const registry = makeRegistry();
    const manager = makeRegistryManager(registry);
    const app = makeApp(manager, registry, repoDir);
    const res = await postSessions(app, validBody({ yolo: "true" }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("yolo must be a boolean");
    await manager.endAll();
  });

  test("rejects missing output_slots", async () => {
    const registry = makeRegistry();
    const manager = makeRegistryManager(registry);
    const app = makeApp(manager, registry, repoDir);
    const { output_slots: _o, ...rest } = validBody();
    const res = await postSessions(app, rest);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("output_slots is required");
    await manager.endAll();
  });

  test("rejects output_slot with missing name", async () => {
    const registry = makeRegistry();
    const manager = makeRegistryManager(registry);
    const app = makeApp(manager, registry, repoDir);
    const res = await postSessions(app, validBody({
      output_slots: [{ artifact_type: "code" }],
    }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("output_slots[].name");
    await manager.endAll();
  });

  test("rejects missing callback", async () => {
    const registry = makeRegistry();
    const manager = makeRegistryManager(registry);
    const app = makeApp(manager, registry, repoDir);
    const { callback: _c, ...rest } = validBody();
    const res = await postSessions(app, rest);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("callback is required");
    await manager.endAll();
  });

  test("rejects callback missing base_url", async () => {
    const registry = makeRegistry();
    const manager = makeRegistryManager(registry);
    const app = makeApp(manager, registry, repoDir);
    const res = await postSessions(app, validBody({
      callback: { stage_instance_id: "s1", emit_path: "/e", status_path: "/s" },
    }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("callback.base_url");
    await manager.endAll();
  });

  test("valid request creates session and returns snapshot", async () => {
    const registry = makeRegistry();
    const manager = makeRegistryManager(registry);
    const app = makeApp(manager, registry, repoDir);
    const res = await postSessions(app, validBody());
    expect(res.status).toBe(200);
    const snap = await res.json() as { sid: string; runtimeId: RuntimeId; status: string };
    expect(typeof snap.sid).toBe("string");
    expect(snap.runtimeId).toBe("claude-code");
    expect(snap.status).toBe("live");
    await manager.endAll();
  });

  test("re-POST for same stage_instance_id is idempotent (no duplicate session)", async () => {
    // Live registry so the first session stays live across the second POST —
    // idempotency only rebinds a LIVE session; an ended one spawns fresh.
    const registry = makeLiveRegistry();
    const manager = makeRegistryManager(registry);
    const app = makeApp(manager, registry, repoDir);

    // First POST creates the session.
    const res1 = await postSessions(app, validBody());
    expect(res1.status).toBe(200);
    const snap1 = (await res1.json()) as { sid: string };

    // Recovery re-POST with the same callback.stage_instance_id — oakridge
    // crashed before persisting the sid and re-runs execute(). kbbl must return
    // the existing session rather than spawn a second claude on the same id.
    const res2 = await postSessions(app, validBody());
    expect(res2.status).toBe(200);
    const snap2 = (await res2.json()) as { sid: string };

    expect(snap2.sid).toBe(snap1.sid);
    expect(manager.listLive().length).toBe(1);

    await manager.endAll();
  });

  test("stale index entry pointing at an ended session is not reused (explicit live filter)", async () => {
    // SessionManager intentionally keeps ended sessions in its map, and onEnded
    // normally clears the stage_instance_id index. This simulates the index
    // going stale — still pointing at a now-ended session — and asserts the
    // lookup filters it out, so a re-POST spawns fresh instead of "deduping"
    // onto a dead session. Without the explicit status === "ended" filter, the
    // final lookup would return the ended session and this test would fail.
    const registry = makeLiveRegistry();
    const manager = makeRegistryManager(registry);
    const app = makeApp(manager, registry, repoDir);

    const res = await postSessions(app, validBody());
    expect(res.status).toBe(200);
    const { sid } = (await res.json()) as { sid: string };

    // End the session; it stays in the map as "ended" and onEnded clears the index.
    await manager.endAll();
    expect(manager.getDelegatedByStageInstance("stage-abc")).toBeNull();

    // Re-introduce a stale index entry (the failure mode the filter defends against).
    const rawIndex = (
      manager as unknown as { delegatedByStageInstance: Map<string, string> }
    ).delegatedByStageInstance;
    rawIndex.set("stage-abc", sid);

    // The ended session must still not be returned.
    expect(manager.getDelegatedByStageInstance("stage-abc")).toBeNull();
    // Self-healing: the stale entry is removed by the lookup, so it can't accumulate.
    expect(rawIndex.has("stage-abc")).toBe(false);
  });

  test("codex backend selects codex runtime", async () => {
    const registry = makeRegistry();
    const manager = makeRegistryManager(registry);
    const app = makeApp(manager, registry, repoDir);
    const res = await postSessions(app, validBody({ backend: "codex" }));
    expect(res.status).toBe(200);
    const snap = await res.json() as { runtimeId: RuntimeId };
    expect(snap.runtimeId).toBe("codex");
    await manager.endAll();
  });

  test("valid model accepted, snapshot.model matches", async () => {
    const registry = makeRegistry();
    const manager = makeRegistryManager(registry);
    const app = makeApp(manager, registry, repoDir);
    const res = await postSessions(app, validBody({ model: "claude-sonnet-4-6" }));
    expect(res.status).toBe(200);
    const snap = await res.json() as { model: string | null };
    expect(snap.model).toBe("claude-sonnet-4-6");
    await manager.endAll();
  });

  test("unknown model returns 400", async () => {
    const registry = makeRegistry();
    const manager = makeRegistryManager(registry);
    const app = makeApp(manager, registry, repoDir);
    const res = await postSessions(app, validBody({ model: "garbage-model" }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("unknown model for claude-code: garbage-model");
    await manager.endAll();
  });

  test("empty model string returns 400", async () => {
    const registry = makeRegistry();
    const manager = makeRegistryManager(registry);
    const app = makeApp(manager, registry, repoDir);
    const res = await postSessions(app, validBody({ model: "" }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("model must be non-empty when provided");
    await manager.endAll();
  });

  test("omitted model → snapshot.model is null", async () => {
    const registry = makeRegistry();
    const manager = makeRegistryManager(registry);
    const app = makeApp(manager, registry, repoDir);
    const res = await postSessions(app, validBody());
    expect(res.status).toBe(200);
    const snap = await res.json() as { model: string | null };
    expect(snap.model).toBeNull();
    await manager.endAll();
  });

  test("accepts Codex model with codex backend", async () => {
    const registry = makeRegistry();
    const manager = makeRegistryManager(registry);
    const app = makeApp(manager, registry, repoDir);
    const res = await postSessions(app, validBody({ backend: "codex", model: "gpt-5.1-codex" }));
    expect(res.status).toBe(200);
    const snap = await res.json() as { runtimeId: RuntimeId; model: string | null };
    expect(snap.runtimeId).toBe("codex");
    expect(snap.model).toBe("gpt-5.1-codex");
    await manager.endAll();
  });

  test("rejects Claude model for codex backend", async () => {
    const registry = makeRegistry();
    const manager = makeRegistryManager(registry);
    const app = makeApp(manager, registry, repoDir);
    const res = await postSessions(app, validBody({ backend: "codex", model: "claude-sonnet-4-6" }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("unknown model for codex: claude-sonnet-4-6");
    await manager.endAll();
  });

  test("workdir defaults to server default when omitted from body", async () => {
    const registry = makeRegistry();
    const manager = makeRegistryManager(registry);
    const app = makeApp(manager, registry, repoDir);
    const { workdir: _w, ...rest } = validBody();
    const res = await postSessions(app, rest);
    expect(res.status).toBe(200);
    await manager.endAll();
  });

  test("unregistered backend returns 400", async () => {
    const registry = createRuntimeRegistry([
      makeRuntime("claude-code", ["claude-sonnet-4-6"]),
    ]);
    const manager = makeRegistryManager(registry);
    const app = makeApp(manager, registry, repoDir);
    const res = await postSessions(app, validBody({ backend: "codex" }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('"codex" is not registered');
    await manager.endAll();
  });
});
