import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

import { KbblConfigSchema } from "../../config";
import { createSafirClient, type FetchFn } from "../../safir/client";
import { createSafirQueue } from "../../safir/queue";
import { SessionManager, type CreateSessionOpts } from "../../session/session-manager";
import type { Session, SpawnCmd } from "../../session/session";
import { mountSessionsRoutes } from "./sessions";

let tmpRoot: string;
let sessionsDir: string;
let worktreesDir: string;

async function noopSpawn(_session: Session): Promise<SpawnCmd> {
  return { cmd: ["true"], cwd: "/tmp", env: {} };
}

function makeManager(): SessionManager {
  // Safir is offline for these tests: every createRun / createPhase /
  // getPermissionProfile call throws and gets swallowed (or queued)
  // inside the manager. We only care that the handler routes the
  // body fields into manager.create() correctly, not that safir is reached.
  const offlineFetch: FetchFn = async () => {
    throw new TypeError("safir disabled in task-binding tests");
  };
  const safirClient = createSafirClient({
    baseUrl: "http://127.0.0.1:1",
    fetch: offlineFetch,
  });
  const safirQueue = createSafirQueue({ dataDir: tmpRoot });
  return new SessionManager({
    sessionsDir,
    handoffsDir: join(tmpRoot, "handoffs"),
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

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kbbl-task-binding-test-"));
  sessionsDir = join(tmpRoot, "sessions");
  worktreesDir = join(tmpRoot, "worktrees");
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(worktreesDir, { recursive: true });
});

afterEach(async () => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("POST /sessions task_id validation", () => {
  test("non-integer task_id → 400", async () => {
    const manager = makeManager();
    try {
      const app = makeApp(manager);
      const res = await postSessions(app, { task_id: 1.5, workdir: "/tmp" });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("task_id must be a positive integer");
    } finally {
      await manager.endAll();
    }
  });

  test("non-number task_id → 400", async () => {
    const manager = makeManager();
    try {
      const app = makeApp(manager);
      const res = await postSessions(app, { task_id: "12", workdir: "/tmp" });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("task_id must be a positive integer");
    } finally {
      await manager.endAll();
    }
  });

  test("zero task_id → 400", async () => {
    const manager = makeManager();
    try {
      const app = makeApp(manager);
      const res = await postSessions(app, { task_id: 0, workdir: "/tmp" });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("task_id must be a positive integer");
    } finally {
      await manager.endAll();
    }
  });
});

describe("POST /sessions run_id validation", () => {
  test("non-string run_id → 400", async () => {
    const manager = makeManager();
    try {
      const app = makeApp(manager);
      const res = await postSessions(app, { run_id: 42, workdir: "/tmp" });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("run_id must be a string");
    } finally {
      await manager.endAll();
    }
  });

  test("empty run_id → 400", async () => {
    const manager = makeManager();
    try {
      const app = makeApp(manager);
      const res = await postSessions(app, { run_id: "", workdir: "/tmp" });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("run_id must be non-empty when provided");
    } finally {
      await manager.endAll();
    }
  });

  test("whitespace-only run_id → 400", async () => {
    const manager = makeManager();
    try {
      const app = makeApp(manager);
      const res = await postSessions(app, { run_id: "   ", workdir: "/tmp" });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("run_id must be non-empty when provided");
    } finally {
      await manager.endAll();
    }
  });
});

describe("POST /sessions permission_profile_id validation", () => {
  test("non-integer permission_profile_id → 400", async () => {
    const manager = makeManager();
    try {
      const app = makeApp(manager);
      const res = await postSessions(app, {
        permission_profile_id: 2.5,
        workdir: "/tmp",
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toBe(
        "permission_profile_id must be a positive integer",
      );
    } finally {
      await manager.endAll();
    }
  });

  test("non-number permission_profile_id → 400", async () => {
    const manager = makeManager();
    try {
      const app = makeApp(manager);
      const res = await postSessions(app, {
        permission_profile_id: "3",
        workdir: "/tmp",
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toBe(
        "permission_profile_id must be a positive integer",
      );
    } finally {
      await manager.endAll();
    }
  });

  test("zero permission_profile_id → 400", async () => {
    const manager = makeManager();
    try {
      const app = makeApp(manager);
      const res = await postSessions(app, {
        permission_profile_id: 0,
        workdir: "/tmp",
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toBe(
        "permission_profile_id must be a positive integer",
      );
    } finally {
      await manager.endAll();
    }
  });
});

describe("POST /sessions task-binding pass-through", () => {
  // Intercept manager.create to capture the opts the handler threaded
  // in. We don't assert against the resulting session snapshot because
  // not all of these fields land on the snapshot (taskId/runId are
  // tracked on Session but not exposed via SessionSnapshot, and the
  // permission profile resolves to null when safir is offline). The
  // contract under test is the *handoff* from HTTP body → manager opts.
  function withCapture(manager: SessionManager): { capturedRef: { current: CreateSessionOpts | null } } {
    const capturedRef = { current: null as CreateSessionOpts | null };
    const original = manager.create.bind(manager);
    manager.create = async (opts: CreateSessionOpts) => {
      capturedRef.current = opts;
      return original(opts);
    };
    return { capturedRef };
  }

  test("task_id alone threads taskId into spawnOpts and returns 200", async () => {
    const manager = makeManager();
    try {
      const { capturedRef } = withCapture(manager);
      const app = makeApp(manager);
      const res = await postSessions(app, { task_id: 12, workdir: "/tmp" });
      expect(res.status).toBe(200);
      expect(capturedRef.current?.taskId).toBe(12);
      expect(capturedRef.current?.runId).toBeUndefined();
      expect(capturedRef.current?.permission_profile_id).toBeUndefined();
    } finally {
      await manager.endAll();
    }
  });

  test("run_id alone threads runId into spawnOpts and returns 200", async () => {
    const manager = makeManager();
    try {
      const { capturedRef } = withCapture(manager);
      const app = makeApp(manager);
      const res = await postSessions(app, {
        run_id: "abc-123",
        workdir: "/tmp",
      });
      expect(res.status).toBe(200);
      expect(capturedRef.current?.taskId).toBeUndefined();
      expect(capturedRef.current?.runId).toBe("abc-123");
      expect(capturedRef.current?.permission_profile_id).toBeUndefined();
    } finally {
      await manager.endAll();
    }
  });

  test("permission_profile_id alone threads through and returns 200", async () => {
    const manager = makeManager();
    try {
      const { capturedRef } = withCapture(manager);
      const app = makeApp(manager);
      const res = await postSessions(app, {
        permission_profile_id: 5,
        workdir: "/tmp",
      });
      expect(res.status).toBe(200);
      expect(capturedRef.current?.taskId).toBeUndefined();
      expect(capturedRef.current?.runId).toBeUndefined();
      expect(capturedRef.current?.permission_profile_id).toBe(5);
    } finally {
      await manager.endAll();
    }
  });

  test("task_id + run_id together both thread through", async () => {
    const manager = makeManager();
    try {
      const { capturedRef } = withCapture(manager);
      const app = makeApp(manager);
      const res = await postSessions(app, {
        task_id: 7,
        run_id: "run-xyz",
        workdir: "/tmp",
      });
      expect(res.status).toBe(200);
      expect(capturedRef.current?.taskId).toBe(7);
      expect(capturedRef.current?.runId).toBe("run-xyz");
    } finally {
      await manager.endAll();
    }
  });

  test("run_id is trimmed before being threaded", async () => {
    const manager = makeManager();
    try {
      const { capturedRef } = withCapture(manager);
      const app = makeApp(manager);
      const res = await postSessions(app, {
        run_id: "  run-trim  ",
        workdir: "/tmp",
      });
      expect(res.status).toBe(200);
      expect(capturedRef.current?.runId).toBe("run-trim");
    } finally {
      await manager.endAll();
    }
  });
});
