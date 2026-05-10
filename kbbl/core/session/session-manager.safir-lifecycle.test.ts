import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KbblConfigSchema, type KbblConfig } from "../config";
import { createSafirClient, type FetchFn } from "../safir/client";
import { createSafirQueue } from "../safir/queue";
import { SessionManager } from "./session-manager";
import type { Session, SpawnCmd } from "./session";

let tmpRoot: string;
let sessionsDir: string;
let worktreesDir: string;

interface StubCall {
  method: string;
  path: string;
  body: unknown;
}

function makeSafirStub(): { fetch: FetchFn; calls: StubCall[] } {
  const calls: StubCall[] = [];
  let nextId = 1;

  const fetchFn: FetchFn = async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const method = (init?.method ?? "GET").toUpperCase();
    const bodyText = typeof init?.body === "string" ? init.body : null;
    const body = bodyText ? (JSON.parse(bodyText) as unknown) : null;

    calls.push({ method, path, body });

    const id = `stub-${nextId++}`;

    if (method === "POST" && /^\/tasks\/\d+\/runs$/.test(path)) {
      return Response.json({ id, ...(body as object) }, { status: 201 });
    }
    if (method === "POST" && /^\/runs\/[^/]+\/phases$/.test(path)) {
      return Response.json({ id, ...(body as object) }, { status: 201 });
    }
    if (method === "PATCH" && /^\/phases\/[^/]+$/.test(path)) {
      return Response.json({ id: path.split("/")[2], ...(body as object) }, { status: 200 });
    }
    if (method === "PATCH" && /^\/runs\/[^/]+$/.test(path)) {
      return Response.json({ id: path.split("/")[2], ...(body as object) }, { status: 200 });
    }
    return Response.json({ error: "stub: unhandled route" }, { status: 404 });
  };

  return { fetch: fetchFn, calls };
}

function buildConfig(): KbblConfig {
  return KbblConfigSchema.parse({
    sessions: { worktree_per_session: false },
  });
}

function hangingSpawn(_session: Session): SpawnCmd {
  return { cmd: ["cat"], cwd: "/tmp", env: {} };
}

function makeManager(fetchFn: FetchFn): SessionManager {
  const safirClient = createSafirClient({
    baseUrl: "http://safir.test",
    fetch: fetchFn,
  });
  const safirQueue = createSafirQueue({ dataDir: tmpRoot });
  return new SessionManager({
    sessionsDir,
    handoffsDir: join(tmpRoot, "handoffs"),
    worktreesDir,
    buildSpawnCmd: hangingSpawn,
    config: buildConfig(),
    safirClient,
    safirQueue,
  });
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kbbl-mgr-safir-test-"));
  sessionsDir = join(tmpRoot, "sessions");
  worktreesDir = join(tmpRoot, "worktrees");
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(worktreesDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});


describe("SessionManager safir lifecycle", () => {
  test("opens a fresh run + phase when taskId is supplied", async () => {
    const stub = makeSafirStub();
    const mgr = makeManager(stub.fetch);
    const session = await mgr.create({ workdir: "/tmp", taskId: 42 });

    const runCall = stub.calls.find((c) => c.method === "POST" && c.path === "/tasks/42/runs");
    expect(runCall).toBeDefined();
    expect(runCall!.body).toMatchObject({
      executor: "claude_code",
      status: "running",
      created_by: "kbbl",
      created_by_session: session.oakridgeSid,
    });

    expect(session.runId).toBeDefined();
    expect(session.phaseId).toBeDefined();

    const phaseCall = stub.calls.find(
      (c) => c.method === "POST" && c.path === `/runs/${session.runId}/phases`,
    );
    expect(phaseCall).toBeDefined();
    expect(phaseCall!.body).toMatchObject({
      oakridge_session_id: session.oakridgeSid,
      parent_phase_id: null,
    });

    await mgr.endAll();
  });

  test("opens a phase under an existing runId without creating a new run", async () => {
    const stub = makeSafirStub();
    const mgr = makeManager(stub.fetch);
    const session = await mgr.create({ workdir: "/tmp", taskId: 42, runId: "r-existing" });

    const runCalls = stub.calls.filter((c) => c.method === "POST" && /\/tasks\//.test(c.path));
    expect(runCalls).toHaveLength(0);

    const phaseCall = stub.calls.find(
      (c) => c.method === "POST" && c.path === "/runs/r-existing/phases",
    );
    expect(phaseCall).toBeDefined();
    expect(session.runId).toBe("r-existing");
    expect(session.phaseId).toBeDefined();

    await mgr.endAll();
  });

  test("threads parentPhaseId into the new phase row", async () => {
    const stub = makeSafirStub();
    const mgr = makeManager(stub.fetch);
    await mgr.create({
      workdir: "/tmp",
      taskId: 42,
      runId: "r-existing",
      parentPhaseId: "p-parent",
    });

    const phaseCall = stub.calls.find(
      (c) => c.method === "POST" && c.path === "/runs/r-existing/phases",
    );
    expect(phaseCall).toBeDefined();
    expect(phaseCall!.body).toMatchObject({ parent_phase_id: "p-parent" });

    await mgr.endAll();
  });

  test("user_closed end closes the phase and completes the run", async () => {
    const stub = makeSafirStub();
    const mgr = makeManager(stub.fetch);
    const session = await mgr.create({ workdir: "/tmp", taskId: 42 });

    session.markEndReason("user_closed");
    await mgr.end(session.oakridgeSid);
    await mgr.drainLifecycle();

    const phaseUpdate = stub.calls.find(
      (c) => c.method === "PATCH" && c.path === `/phases/${session.phaseId}`,
    );
    expect(phaseUpdate).toBeDefined();
    expect(phaseUpdate!.body).toMatchObject({
      end_reason: "user_closed",
      is_terminal: true,
    });
    expect((phaseUpdate!.body as Record<string, unknown>).ended_at).toBeDefined();

    const runUpdate = stub.calls.find(
      (c) => c.method === "PATCH" && c.path === `/runs/${session.runId}`,
    );
    expect(runUpdate).toBeDefined();
    expect(runUpdate!.body).toMatchObject({ status: "completed" });
  });

  test("subprocess_exited (default) closes the phase but keeps the run running", async () => {
    const stub = makeSafirStub();
    const mgr = makeManager(stub.fetch);
    const session = await mgr.create({ workdir: "/tmp", taskId: 42 });

    await mgr.end(session.oakridgeSid);
    await mgr.drainLifecycle();

    const phaseUpdate = stub.calls.find(
      (c) => c.method === "PATCH" && c.path === `/phases/${session.phaseId}`,
    );
    expect(phaseUpdate).toBeDefined();
    expect(phaseUpdate!.body).toMatchObject({
      end_reason: "subprocess_exited",
      is_terminal: true,
    });

    const runUpdate = stub.calls.find(
      (c) => c.method === "PATCH" && c.path === `/runs/${session.runId}`,
    );
    expect(runUpdate).toBeUndefined();
  });

  test("safir-down at create: session is usable, runId/phaseId stay undefined, end is a no-op", async () => {
    const downFetch: FetchFn = () => {
      throw new TypeError("safir down");
    };
    const mgr = makeManager(downFetch);
    const session = await mgr.create({ workdir: "/tmp", taskId: 42 });

    expect(session.runId).toBeUndefined();
    expect(session.phaseId).toBeUndefined();

    session.markEndReason("user_closed");
    await mgr.end(session.oakridgeSid);
    await mgr.drainLifecycle();
    // Nothing to assert on safir; just confirm no exception escaped.
  });

  test("safir-down enqueues the createRun POST", async () => {
    const downFetch: FetchFn = () => {
      throw new TypeError("safir down");
    };
    const mgr = makeManager(downFetch);
    const session = await mgr.create({ workdir: "/tmp", taskId: 42 });

    const queueFile = join(tmpRoot, "safir-queue.jsonl");
    expect(existsSync(queueFile)).toBe(true);
    const lines = readFileSync(queueFile, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(1);
    expect((lines[0].request as Record<string, unknown>).method).toBe("POST");
    expect((lines[0].request as Record<string, unknown>).path).toBe("/tasks/42/runs");
    expect((lines[0].request as Record<string, unknown>).body).toEqual({
      executor: "claude_code",
      status: "running",
      created_by: "kbbl",
      created_by_session: session.oakridgeSid,
    });
    expect(lines[0].delivered_at).toBeUndefined();

    await mgr.end(session.oakridgeSid);
  });
});
