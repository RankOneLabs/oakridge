import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";

import { KbblConfigSchema } from "../../config";
import { createSafirClient, type FetchFn } from "../../safir/client";
import { createSafirQueue } from "../../safir/queue";
import { SessionManager } from "../../session/session-manager";
import type { Session, SpawnCmd } from "../../session/session";
import { mountSessionsRoutes } from "./sessions";

let tmpRoot: string;
let sessionsDir: string;
let worktreesDir: string;

function noopSpawn(_session: Session): SpawnCmd {
  return { cmd: ["true"], cwd: "/tmp", env: {} };
}

function makeManager(): SessionManager {
  const offlineFetch: FetchFn = async () => {
    throw new TypeError("safir disabled in model tests");
  };
  const safirClient = createSafirClient({
    baseUrl: "http://127.0.0.1:1",
    fetch: offlineFetch,
  });
  const safirQueue = createSafirQueue({ dataDir: tmpRoot });
  return new SessionManager({
    sessionsDir,
    worktreesDir,
    buildSpawnCmd: noopSpawn,
    config: KbblConfigSchema.parse({}),
    safirClient,
    safirQueue,
  });
}

function makeApp(manager: SessionManager): Hono {
  const app = new Hono();
  mountSessionsRoutes(app, {
    manager,
    defaultWorkdir: "/tmp",
    sessionsDir,
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
});
