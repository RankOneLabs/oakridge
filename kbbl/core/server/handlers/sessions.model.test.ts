import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
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

let tmpRoot: string;
let sessionsDir: string;
let worktreesDir: string;

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
  defaultWorkdir: string | null = "/tmp",
): Hono {
  const app = new Hono();
  mountSessionsRoutes(app, {
    manager,
    defaultWorkdir,
    sessionsDir,
    registry,
  });
  return app;
}

async function postSessions(app: Hono, body: Record<string, unknown>): Promise<Response> {
  return app.request("/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Write a minimal archived JSONL for a fake parent session. */
async function writeArchivedParent(opts: {
  sid: string;
  model: string | null;
  runtimeId?: RuntimeId;
  ccSid?: string;
}): Promise<void> {
  const ccSid = opts.ccSid ?? `fake-cc-${opts.sid.slice(0, 8)}`;
  const lines = [
    JSON.stringify({
      id: 0,
      type: "session_started",
      ts: "2025-01-01T00:00:00.000Z",
      payload: {
        command: ["true"],
        workdir: "/tmp",
        name: "parent",
        sessionId: opts.sid,
        parentCcSid: null,
        parentOakridgeSid: null,
        artifactId: null,
        runtimeId: opts.runtimeId ?? "claude-code",
        worktreePath: null,
        worktreeBranch: null,
        worktreeBaseRef: null,
        projectWorkdir: null,
        model: opts.model,
      },
    }),
    JSON.stringify({
      id: 1,
      type: "cc_session_id_observed",
      ts: "2025-01-01T00:00:01.000Z",
      payload: { cc_session_id: ccSid },
    }),
    JSON.stringify({
      id: 2,
      type: "subprocess_exited",
      ts: "2025-01-01T00:00:02.000Z",
      payload: { code: 0, reason: "clean" },
    }),
  ];
  await writeFile(join(sessionsDir, `${opts.sid}.jsonl`), lines.join("\n") + "\n");
}

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kbbl-model-test-"));
  sessionsDir = join(tmpRoot, "sessions");
  worktreesDir = join(tmpRoot, "worktrees");
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(worktreesDir, { recursive: true });
});

afterEach(async () => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("POST /sessions model validation", () => {
  test("rejects fresh session without workdir when no default is configured", async () => {
    const manager = makeManager();
    const app = makeApp(manager, undefined, null);

    const res = await postSessions(app, {});

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("workdir is required");
  });

  test("case 1: valid model accepted, snapshot.model matches", async () => {
    const manager = makeManager();
    const app = makeApp(manager);
    const res = await postSessions(app, { model: "claude-sonnet-4-6", workdir: "/tmp" });
    expect(res.status).toBe(200);
    const body = await res.json() as { model: string | null };
    expect(body.model).toBe("claude-sonnet-4-6");
    await manager.endAll();
  });

  test("case 2: unknown model returns 400 with error", async () => {
    const manager = makeManager();
    try {
      const app = makeApp(manager);
      const res = await postSessions(app, { model: "garbage", workdir: "/tmp" });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("unknown model: garbage");
    } finally {
      await manager.endAll();
    }
  });

  test("case 3: empty string model returns 400 with error", async () => {
    const manager = makeManager();
    try {
      const app = makeApp(manager);
      const res = await postSessions(app, { model: "", workdir: "/tmp" });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("model must be non-empty when provided");
    } finally {
      await manager.endAll();
    }
  });

  test("case 4: non-string model returns 400 with error", async () => {
    const manager = makeManager();
    try {
      const app = makeApp(manager);
      const res = await postSessions(app, { model: 42, workdir: "/tmp" });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("model must be a string");
    } finally {
      await manager.endAll();
    }
  });

  test("case 5: omitted model → snapshot.model is null", async () => {
    const manager = makeManager();
    const app = makeApp(manager);
    const res = await postSessions(app, { workdir: "/tmp" });
    expect(res.status).toBe(200);
    const body = await res.json() as { model: string | null };
    expect(body.model).toBeNull();
    await manager.endAll();
  });

  test("case 6: resume inherits parent model when no model in body", async () => {
    const parentSid = randomUUID();
    await writeArchivedParent({ sid: parentSid, model: "claude-sonnet-4-6" });
    const manager = makeManager();
    const app = makeApp(manager);
    const res = await postSessions(app, { resume_from: parentSid });
    expect(res.status).toBe(200);
    const body = await res.json() as { model: string | null };
    expect(body.model).toBe("claude-sonnet-4-6");
    await manager.endAll();
  });

  test("case 7: resume with explicit model overrides parent model", async () => {
    const parentSid = randomUUID();
    await writeArchivedParent({ sid: parentSid, model: "claude-sonnet-4-6" });
    const manager = makeManager();
    const app = makeApp(manager);
    const res = await postSessions(app, {
      resume_from: parentSid,
      model: "claude-opus-4-7",
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { model: string | null };
    expect(body.model).toBe("claude-opus-4-7");
    await manager.endAll();
  });

  test("case 8: resume from archived parent (disk-only) inherits model", async () => {
    const parentSid = randomUUID();
    await writeArchivedParent({ sid: parentSid, model: "claude-haiku-4-5-20251001" });
    // Explicitly not adding the parent to any in-memory manager — it only exists on disk.
    const manager = makeManager();
    const app = makeApp(manager);
    const res = await postSessions(app, { resume_from: parentSid });
    expect(res.status).toBe(200);
    const body = await res.json() as { model: string | null };
    expect(body.model).toBe("claude-haiku-4-5-20251001");
    await manager.endAll();
  });

  test("accepts a Codex model when runtime is Codex", async () => {
    const registry = makeRegistry();
    const manager = makeRegistryManager(registry);
    const app = makeApp(manager, registry);
    const res = await postSessions(app, {
      runtime: "codex",
      model: "gpt-5.1-codex",
      workdir: "/tmp",
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { runtimeId: RuntimeId; model: string | null };
    expect(body.runtimeId).toBe("codex");
    expect(body.model).toBe("gpt-5.1-codex");
    await manager.endAll();
  });

  test("rejects a Claude model for Codex runtime", async () => {
    const registry = makeRegistry();
    const manager = makeRegistryManager(registry);
    try {
      const app = makeApp(manager, registry);
      const res = await postSessions(app, {
        runtime: "codex",
        model: "claude-sonnet-4-6",
        workdir: "/tmp",
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("unknown model for codex: claude-sonnet-4-6");
    } finally {
      await manager.endAll();
    }
  });

  test("rejects a Codex model for Claude runtime", async () => {
    const registry = makeRegistry();
    const manager = makeRegistryManager(registry);
    try {
      const app = makeApp(manager, registry);
      const res = await postSessions(app, {
        runtime: "claude-code",
        model: "gpt-5.1-codex",
        workdir: "/tmp",
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("unknown model for claude-code: gpt-5.1-codex");
    } finally {
      await manager.endAll();
    }
  });

  test("omitted runtime validates against configured default runtime", async () => {
    const registry = makeRegistry("codex");
    const manager = makeRegistryManager(registry);
    const app = makeApp(manager, registry);
    const res = await postSessions(app, {
      model: "gpt-5.1-codex",
      workdir: "/tmp",
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { runtimeId: RuntimeId; model: string | null };
    expect(body.runtimeId).toBe("codex");
    expect(body.model).toBe("gpt-5.1-codex");
    await manager.endAll();
  });

  test("unknown runtime returns 400", async () => {
    const registry = makeRegistry();
    const manager = makeRegistryManager(registry);
    try {
      const app = makeApp(manager, registry);
      const res = await postSessions(app, {
        runtime: "future-runtime",
        workdir: "/tmp",
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      const registered = [...registry.runtimes.keys()].join(", ");
      expect(body.error).toContain("unknown runtime: future-runtime");
      expect(body.error).toContain(`registered: ${registered}`);
    } finally {
      await manager.endAll();
    }
  });

  test("resume rejects cross-runtime override", async () => {
    const registry = makeRegistry();
    const manager = makeRegistryManager(registry);
    try {
      const parent = await manager.create({ workdir: "/tmp", runtime: "codex" });
      const app = makeApp(manager, registry);
      const res = await postSessions(app, {
        resume_from: parent.oakridgeSid,
        runtime: "claude-code",
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toBe(
        "resume_from parent runtime is codex; cross-runtime resume to claude-code is not supported",
      );
    } finally {
      await manager.endAll();
    }
  });

  test("resume returns 400 when parent runtime is not registered", async () => {
    const parentSid = randomUUID();
    await writeArchivedParent({
      sid: parentSid,
      runtimeId: "codex",
      model: null,
    });
    const registry = createRuntimeRegistry([
      makeRuntime("claude-code", ["claude-sonnet-4-6", "claude-opus-4-7"]),
    ]);
    const manager = makeRegistryManager(registry);
    try {
      const app = makeApp(manager, registry);
      const res = await postSessions(app, { resume_from: parentSid });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('resume_from parent runtime "codex" is not registered');
    } finally {
      await manager.endAll();
    }
  });
});
