import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { Database } from "bun:sqlite";

import { KbblConfigSchema, type KbblConfig } from "../config";
import { createSafirClient, type FetchFn } from "../safir/client";
import { createSafirQueue } from "../safir/queue";
import { SessionManager } from "./session-manager";
import type { Session, SpawnCmd } from "./session";

import { initDb } from "../../../../../personal/safir/src/db/index.ts";
import { taskRoutes } from "../../../../../personal/safir/src/api/routes/tasks.ts";
import {
  runRoutes,
  taskRunRoutes,
} from "../../../../../personal/safir/src/api/routes/runs.ts";
import {
  phaseRoutes,
  runPhaseRoutes,
} from "../../../../../personal/safir/src/api/routes/phases.ts";
import {
  handoffRoutes,
  taskHandoffRoutes,
} from "../../../../../personal/safir/src/api/routes/handoffs.ts";
import { createProject, createTask } from "../../../../../personal/safir/src/db/queries.ts";

let tmpRoot: string;
let sessionsDir: string;
let worktreesDir: string;
let db: Database;
let safirApp: Hono;

function buildSafirApp(database: Database): Hono {
  const a = new Hono();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  a.route("/tasks", taskRoutes(database) as any);
  a.route("/tasks", taskRunRoutes(database) as any);
  a.route("/tasks", taskHandoffRoutes(database) as any);
  a.route("/runs", runRoutes(database) as any);
  a.route("/runs", runPhaseRoutes(database) as any);
  a.route("/phases", phaseRoutes(database) as any);
  a.route("/handoffs", handoffRoutes(database) as any);
  return a;
}

function buildConfig(): KbblConfig {
  return KbblConfigSchema.parse({
    sessions: { worktree_per_session: false },
  });
}

function hangingSpawn(_session: Session): SpawnCmd {
  return { cmd: ["cat"], cwd: "/tmp", env: {} };
}

function makeManagerAgainstApp(): SessionManager {
  const safirFetch: FetchFn = async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    return safirApp.request(path, init as RequestInit);
  };
  const safirClient = createSafirClient({
    baseUrl: "http://safir.test",
    fetch: safirFetch,
  });
  const safirQueue = createSafirQueue({ dataDir: tmpRoot });
  return new SessionManager({
    sessionsDir,
    worktreesDir,
    buildSpawnCmd: hangingSpawn,
    config: buildConfig(),
    safirClient,
    safirQueue,
  });
}

function makeManagerWithDownSafir(): SessionManager {
  const downFetch: FetchFn = () => {
    throw new TypeError("safir down");
  };
  const safirClient = createSafirClient({
    baseUrl: "http://safir.test",
    fetch: downFetch,
  });
  const safirQueue = createSafirQueue({ dataDir: tmpRoot });
  return new SessionManager({
    sessionsDir,
    worktreesDir,
    buildSpawnCmd: hangingSpawn,
    config: buildConfig(),
    safirClient,
    safirQueue,
  });
}

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kbbl-mgr-safir-test-"));
  sessionsDir = join(tmpRoot, "sessions");
  worktreesDir = join(tmpRoot, "worktrees");
  const init = Bun.spawn({
    cmd: ["mkdir", "-p", sessionsDir, worktreesDir],
  });
  await init.exited;
  db = initDb(":memory:");
  createProject(db, { id: "p", name: "test", color: "#3b82f6" });
  safirApp = buildSafirApp(db);
});

afterEach(async () => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const flushFireAndForget = () => new Promise<void>((r) => setImmediate(r));

describe("SessionManager safir lifecycle", () => {
  test("opens a fresh run + phase when taskId is supplied", async () => {
    const T = createTask(db, { project_id: "p", title: "t", status: "backlog", priority: 0 });
    const mgr = makeManagerAgainstApp();
    const session = await mgr.create({ workdir: "/tmp", taskId: T.id });

    const runs = db.query("SELECT * FROM task_runs WHERE task_id = ?").all(T.id) as any[];
    expect(runs).toHaveLength(1);
    expect(runs[0].executor).toBe("claude_code");
    expect(runs[0].status).toBe("running");
    expect(runs[0].created_by).toBe("kbbl");
    expect(runs[0].created_by_session).toBe(session.oakridgeSid);

    const phases = db
      .query("SELECT * FROM run_phases WHERE run_id = ?")
      .all(runs[0].id) as any[];
    expect(phases).toHaveLength(1);
    expect(phases[0].oakridge_session_id).toBe(session.oakridgeSid);
    expect(phases[0].parent_phase_id).toBeNull();

    expect(session.runId).toBe(runs[0].id);
    expect(session.phaseId).toBe(phases[0].id);

    await mgr.endAll();
  });

  test("opens a phase under an existing runId without creating a new run", async () => {
    const T = createTask(db, { project_id: "p", title: "t", status: "backlog", priority: 0 });
    const mgr = makeManagerAgainstApp();
    const directClient = createSafirClient({
      baseUrl: "http://safir.test",
      fetch: async (input, init) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        return safirApp.request(
          url.replace(/^https?:\/\/[^/]+/, ""),
          init as RequestInit,
        );
      },
    });
    const R = await directClient.createRun(T.id, {
      executor: "claude_code",
      status: "running",
    });
    const session = await mgr.create({
      workdir: "/tmp",
      taskId: T.id,
      runId: R.id,
    });

    const runs = db.query("SELECT * FROM task_runs WHERE task_id = ?").all(T.id) as any[];
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe(R.id);

    const phases = db
      .query("SELECT * FROM run_phases WHERE run_id = ?")
      .all(R.id) as any[];
    expect(phases).toHaveLength(1);
    expect(phases[0].oakridge_session_id).toBe(session.oakridgeSid);
    expect(phases[0].parent_phase_id).toBeNull();
    await mgr.endAll();
  });

  test("threads parentPhaseId into the new phase row", async () => {
    const T = createTask(db, { project_id: "p", title: "t", status: "backlog", priority: 0 });
    const directClient = createSafirClient({
      baseUrl: "http://safir.test",
      fetch: async (input, init) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        return safirApp.request(
          url.replace(/^https?:\/\/[^/]+/, ""),
          init as RequestInit,
        );
      },
    });
    const R = await directClient.createRun(T.id, {
      executor: "claude_code",
      status: "running",
    });
    const P = await directClient.createPhase(R.id, {
      oakridge_session_id: "prev-sid",
    });

    const mgr = makeManagerAgainstApp();
    const session = await mgr.create({
      workdir: "/tmp",
      taskId: T.id,
      runId: R.id,
      parentPhaseId: P.id,
    });

    const phases = db
      .query("SELECT * FROM run_phases WHERE run_id = ? ORDER BY phase_index ASC")
      .all(R.id) as any[];
    expect(phases).toHaveLength(2);
    const newPhase = phases.find((p) => p.oakridge_session_id === session.oakridgeSid)!;
    expect(newPhase.parent_phase_id).toBe(P.id);
    await mgr.endAll();
  });

  test("user_closed end closes the phase and completes the run", async () => {
    const T = createTask(db, { project_id: "p", title: "t", status: "backlog", priority: 0 });
    const mgr = makeManagerAgainstApp();
    const session = await mgr.create({ workdir: "/tmp", taskId: T.id });

    session.markEndReason("user_closed");
    await mgr.end(session.oakridgeSid);
    await flushFireAndForget();

    const phases = db
      .query("SELECT * FROM run_phases WHERE id = ?")
      .all(session.phaseId!) as any[];
    expect(phases[0].end_reason).toBe("user_closed");
    expect(phases[0].is_terminal).toBe(1);
    expect(phases[0].ended_at).not.toBeNull();

    const runs = db
      .query("SELECT * FROM task_runs WHERE id = ?")
      .all(session.runId!) as any[];
    expect(runs[0].status).toBe("completed");
  });

  test("subprocess_exited (default) closes the phase but keeps the run running", async () => {
    const T = createTask(db, { project_id: "p", title: "t", status: "backlog", priority: 0 });
    const mgr = makeManagerAgainstApp();
    const session = await mgr.create({ workdir: "/tmp", taskId: T.id });

    await mgr.end(session.oakridgeSid);
    await flushFireAndForget();

    const phases = db
      .query("SELECT * FROM run_phases WHERE id = ?")
      .all(session.phaseId!) as any[];
    expect(phases[0].end_reason).toBe("subprocess_exited");
    expect(phases[0].is_terminal).toBe(1);

    const runs = db
      .query("SELECT * FROM task_runs WHERE id = ?")
      .all(session.runId!) as any[];
    expect(runs[0].status).toBe("running");
  });

  test("safir-down at create: session is usable, runId/phaseId stay undefined, end is a no-op", async () => {
    const mgr = makeManagerWithDownSafir();
    const session = await mgr.create({ workdir: "/tmp", taskId: 42 });

    expect(session.runId).toBeUndefined();
    expect(session.phaseId).toBeUndefined();

    session.markEndReason("user_closed");
    await mgr.end(session.oakridgeSid);
    await flushFireAndForget();
    // Nothing to assert on safir DB; just confirm no exception escaped.
  });

  test("safir-down enqueues the createRun POST", async () => {
    const mgr = makeManagerWithDownSafir();
    const session = await mgr.create({ workdir: "/tmp", taskId: 42 });
    const queueFile = join(tmpRoot, "safir-queue.jsonl");
    expect(existsSync(queueFile)).toBe(true);
    const lines = readFileSync(queueFile, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0].request.method).toBe("POST");
    expect(lines[0].request.path).toBe("/tasks/42/runs");
    expect(lines[0].request.body).toEqual({
      executor: "claude_code",
      status: "running",
      created_by: "kbbl",
      created_by_session: session.oakridgeSid,
    });
    expect(lines[0].delivered_at).toBeUndefined();

    // Cleanup so the worktree afterEach rm doesn't trip on a dangling subprocess.
    await mgr.end(session.oakridgeSid);
  });
});
