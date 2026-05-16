import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KbblConfigSchema, type KbblConfig } from "../config";
import { createSafirClient, type FetchFn } from "../safir/client";
import { createSafirQueue } from "../safir/queue";
import type { PermissionProfile } from "../safir/types";
import { classifyCcEvent } from "../../adapters/claude-code/event-classifier";
import { SessionManager } from "./session-manager";
import type { Session, SpawnCmd } from "./session";

let tmpRoot: string;
let sessionsDir: string;
let worktreesDir: string;
let handoffsDir: string;

const mockCcPath = join(import.meta.dir, "__fixtures__", "mock-cc.ts");

function buildConfig(
  overrides: Partial<KbblConfig["compact"]> = {},
): KbblConfig {
  const base = KbblConfigSchema.parse({});
  return {
    ...base,
    compact: { ...base.compact, ...overrides },
    sessions: { ...base.sessions, worktree_per_session: false },
  };
}

async function spawnEcho(_session: Session): Promise<SpawnCmd> {
  return {
    cmd: ["bun", "run", mockCcPath],
    cwd: tmpRoot,
    env: {
      ...process.env,
      MOCK_CC_BEHAVIOR: "echo_compact_reply",
    } as Record<string, string>,
  };
}

async function spawnGarbage(_session: Session): Promise<SpawnCmd> {
  return {
    cmd: ["bun", "run", mockCcPath],
    cwd: tmpRoot,
    env: {
      ...process.env,
      MOCK_CC_BEHAVIOR: "garbage_reply",
    } as Record<string, string>,
  };
}

async function spawnStall(_session: Session): Promise<SpawnCmd> {
  return {
    cmd: ["bun", "run", mockCcPath],
    cwd: tmpRoot,
    env: {
      ...process.env,
      MOCK_CC_BEHAVIOR: "stall",
    } as Record<string, string>,
  };
}

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
      return Response.json(
        { id, ...(body as object) },
        { status: 201 },
      );
    }
    if (method === "POST" && /^\/runs\/[^/]+\/phases$/.test(path)) {
      return Response.json(
        { id, ...(body as object) },
        { status: 201 },
      );
    }
    if (method === "POST" && /^\/phases\/[^/]+\/handoff$/.test(path)) {
      const phaseId = path.split("/")[2];
      return Response.json(
        {
          id: "h-stub",
          phase_id: phaseId,
          run_id: "r-stub",
          role: "phase_output",
          schema_version: 1,
          goal: "g",
          active_subgoals: [],
          decisions_made: [],
          approaches_rejected: [],
          files_in_scope: [],
          open_questions: [],
          next_action: null,
          raw_markdown: "# stub\n",
          produced_at: "2026-05-09T00:00:00.000Z",
        },
        { status: 201 },
      );
    }
    if (method === "PATCH" && /^\/phases\/[^/]+$/.test(path)) {
      return Response.json(
        { id: path.split("/")[2], ...(body as object) },
        { status: 200 },
      );
    }
    if (method === "PATCH" && /^\/runs\/[^/]+$/.test(path)) {
      return Response.json(
        { id: path.split("/")[2], ...(body as object) },
        { status: 200 },
      );
    }
    return Response.json({ error: "stub: unhandled route" }, { status: 404 });
  };
  return { fetch: fetchFn, calls };
}

function makeManager(opts: {
  fetchFn: FetchFn;
  spawn: (s: Session) => Promise<SpawnCmd>;
  config?: Partial<KbblConfig["compact"]>;
}): SessionManager {
  const safirClient = createSafirClient({
    baseUrl: "http://safir.test",
    fetch: opts.fetchFn,
  });
  const safirQueue = createSafirQueue({ dataDir: tmpRoot });
  return new SessionManager({
    sessionsDir,
    handoffsDir,
    worktreesDir,
    buildSpawnCmd: opts.spawn,
    classifyEvent: classifyCcEvent,
    config: buildConfig(opts.config),
    safirClient,
    safirQueue,
  });
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function waitForStatus(
  session: Session,
  target: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (session.status === target) return;
    await Bun.sleep(20);
  }
  throw new Error(
    `waitForStatus(${target}) timed out after ${timeoutMs}ms; last=${session.status}`,
  );
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kbbl-runcompact-test-"));
  sessionsDir = join(tmpRoot, "sessions");
  worktreesDir = join(tmpRoot, "worktrees");
  handoffsDir = join(tmpRoot, "handoffs");
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(worktreesDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("runCompact happy path", () => {
  test("persists handoff, submits to safir, spawns successor", async () => {
    const stub = makeSafirStub();
    const mgr = makeManager({ fetchFn: stub.fetch, spawn: spawnEcho });
    const session = await mgr.create({ workdir: tmpRoot, taskId: 42 });
    const oldSid = session.oakridgeSid;
    const oldRunId = session.runId!;
    const oldPhaseId = session.phaseId!;

    await mgr.runCompact(oldSid, { kind: "manual" });
    await waitForStatus(session, "ended", 5000);
    await mgr.drainLifecycle();

    expect(existsSync(join(handoffsDir, `${oldSid}.md`))).toBe(true);
    const md = readFileSync(join(handoffsDir, `${oldSid}.md`), "utf8");
    expect(md).toContain("Finish the build plan.");

    const handoffCalls = stub.calls.filter(
      (c) =>
        c.method === "POST" &&
        c.path === `/phases/${oldPhaseId}/handoff`,
    );
    expect(handoffCalls).toHaveLength(1);
    const submittedBody = handoffCalls[0]!.body as {
      raw_markdown: string;
      parsed: { goal: string };
    };
    expect(submittedBody.parsed.goal).toBe("Finish the build plan.");

    const successor = mgr
      .list()
      .find((s) => s.parentOakridgeSid === oldSid);
    expect(successor).toBeDefined();

    const successorPhaseCalls = stub.calls.filter(
      (c) =>
        c.method === "POST" && c.path === `/runs/${oldRunId}/phases`,
    );
    expect(successorPhaseCalls.length).toBeGreaterThanOrEqual(1);
    const successorPhaseCall =
      successorPhaseCalls[successorPhaseCalls.length - 1]!;
    expect(
      (successorPhaseCall.body as { parent_phase_id?: string }).parent_phase_id,
    ).toBe(oldPhaseId);

    expect(session.endReason).toBe("compacted");
    expect(session.status).toBe("ended");
    const successorSnap = successor!.snapshot();
    const oldSnap = session.snapshot();
    expect(oldSnap.endReason).toBe("compacted");
    expect(oldSnap.successorSid).toBe(successor!.oakridgeSid);
    expect(oldSnap.status).toBe("ended");
    expect(successorSnap.endReason).toBeNull();
    expect(successorSnap.successorSid).toBeNull();

    const oldPhasePatchCalls = stub.calls.filter(
      (c) => c.method === "PATCH" && c.path === `/phases/${oldPhaseId}`,
    );
    expect(oldPhasePatchCalls).toHaveLength(1);
    expect(oldPhasePatchCalls[0]!.body).toMatchObject({
      end_reason: "compacted",
      is_terminal: false,
    });

    const runPatchCalls = stub.calls.filter(
      (c) => c.method === "PATCH" && c.path === `/runs/${oldRunId}`,
    );
    expect(runPatchCalls).toHaveLength(0);

    await mgr.endAll();
    await mgr.drainLifecycle();
  }, 15000);
});

describe("runCompact failure modes", () => {
  test("compact timeout: status reverts to live, compact_failed{phase:timeout}", async () => {
    const stub = makeSafirStub();
    const mgr = makeManager({
      fetchFn: stub.fetch,
      spawn: spawnStall,
      config: { compact_call_timeout_seconds: 1 },
    });
    const session = await mgr.create({ workdir: tmpRoot, taskId: 42 });
    const oldSid = session.oakridgeSid;
    const oldPhaseId = session.phaseId!;

    await mgr.runCompact(oldSid, { kind: "manual" });
    await session.flushTranscript();

    expect(session.status).toBe("live");

    const events = readJsonl(join(sessionsDir, `${oldSid}.jsonl`));
    const failed = events.find((e) => e.type === "compact_failed");
    expect(failed).toBeDefined();
    expect((failed!.payload as { phase: string }).phase).toBe("timeout");

    const successor = mgr.list().find((s) => s.parentOakridgeSid === oldSid);
    expect(successor).toBeUndefined();

    const handoffCalls = stub.calls.filter(
      (c) => c.path === `/phases/${oldPhaseId}/handoff`,
    );
    expect(handoffCalls).toHaveLength(0);

    await mgr.endAll();
    await mgr.drainLifecycle();
  }, 15000);

  test("garbage parse: successor still spawns with raw_markdown", async () => {
    const stub = makeSafirStub();
    const mgr = makeManager({ fetchFn: stub.fetch, spawn: spawnGarbage });
    const session = await mgr.create({ workdir: tmpRoot, taskId: 42 });
    const oldSid = session.oakridgeSid;
    const oldPhaseId = session.phaseId!;

    await mgr.runCompact(oldSid, { kind: "manual" });
    await waitForStatus(session, "ended", 5000);
    await mgr.drainLifecycle();

    const successor = mgr.list().find((s) => s.parentOakridgeSid === oldSid);
    expect(successor).toBeDefined();

    const md = readFileSync(join(handoffsDir, `${oldSid}.md`), "utf8");
    expect(md).toBe("no structure");

    const handoffCalls = stub.calls.filter(
      (c) =>
        c.method === "POST" &&
        c.path === `/phases/${oldPhaseId}/handoff`,
    );
    expect(handoffCalls).toHaveLength(1);
    const body = handoffCalls[0]!.body as {
      raw_markdown: string;
      parsed: { goal: string };
    };
    expect(body.raw_markdown).toBe("no structure");
    expect(body.parsed.goal).toBe("");

    expect(session.endReason).toBe("compacted");

    await mgr.endAll();
    await mgr.drainLifecycle();
  }, 15000);

  test("successor spawn failure: compact_succeeded_but_resume_failed; old session stays live", async () => {
    const stub = makeSafirStub();
    let callCount = 0;
    const switchSpawn = async (s: Session): Promise<SpawnCmd> => {
      callCount++;
      if (callCount === 1) return spawnEcho(s);
      // Force Bun.spawn to throw ENOENT for the successor.
      return {
        cmd: ["/this/path/does/not/exist/mock-cc-fail"],
        cwd: tmpRoot,
        env: { ...process.env } as Record<string, string>,
      };
    };
    const mgr = makeManager({ fetchFn: stub.fetch, spawn: switchSpawn });
    const session = await mgr.create({ workdir: tmpRoot, taskId: 42 });
    const oldSid = session.oakridgeSid;
    const oldPhaseId = session.phaseId!;

    await mgr.runCompact(oldSid, { kind: "manual" });
    await mgr.drainLifecycle();
    await session.flushTranscript();

    expect(existsSync(join(handoffsDir, `${oldSid}.md`))).toBe(true);

    const events = readJsonl(join(sessionsDir, `${oldSid}.jsonl`));
    const resumeFailed = events.find(
      (e) => e.type === "compact_succeeded_but_resume_failed",
    );
    expect(resumeFailed).toBeDefined();

    expect(session.status).toBe("live");

    const handoffCalls = stub.calls.filter(
      (c) =>
        c.method === "POST" &&
        c.path === `/phases/${oldPhaseId}/handoff`,
    );
    expect(handoffCalls).toHaveLength(1);

    await mgr.endAll();
    await mgr.drainLifecycle();
  }, 15000);
});

describe("requestManualCompact", () => {
  test("not_found when no session with that sid", async () => {
    const stub = makeSafirStub();
    const mgr = makeManager({ fetchFn: stub.fetch, spawn: spawnEcho });
    const result = mgr.requestManualCompact("00000000-0000-4000-8000-000000000000");
    expect(result).toBe("not_found");
    await mgr.endAll();
    await mgr.drainLifecycle();
  });

  test("not_live when session is not live", async () => {
    const stub = makeSafirStub();
    const mgr = makeManager({ fetchFn: stub.fetch, spawn: spawnEcho });
    const session = await mgr.create({ workdir: tmpRoot, taskId: 42 });
    const sid = session.oakridgeSid;
    await mgr.runCompact(sid, { kind: "manual" });
    await waitForStatus(session, "ended", 5000);
    const result = mgr.requestManualCompact(sid);
    expect(result).toBe("not_live");
    await mgr.endAll();
    await mgr.drainLifecycle();
  }, 15000);

  test("ok and fires compaction on live session", async () => {
    const stub = makeSafirStub();
    const mgr = makeManager({ fetchFn: stub.fetch, spawn: spawnEcho });
    const session = await mgr.create({ workdir: tmpRoot, taskId: 42 });
    const sid = session.oakridgeSid;
    const result = mgr.requestManualCompact(sid);
    expect(result).toBe("ok");
    await waitForStatus(session, "ended", 5000);
    expect(session.endReason).toBe("compacted");
    await mgr.endAll();
    await mgr.drainLifecycle();
  }, 15000);
});

describe("compact_overrides from permission profile", () => {
  test("profile compact_overrides.soft_threshold_tokens overrides global config", async () => {
    const overrideProfile: PermissionProfile = {
      id: 99,
      name: "compact-override-test",
      description: null,
      is_seed: false,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      rules: {
        auto_approve: [],
        always_prompt: [],
        deny: [],
        compact_overrides: { soft_threshold_tokens: 50 },
      },
    };

    const baseStub = makeSafirStub();
    const fetchWithProfile: FetchFn = async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path === "/permission-profiles/99") {
        return Response.json(overrideProfile, { status: 200 });
      }
      return baseStub.fetch(input, init);
    };

    // Global threshold is very high — without the override, no compact would schedule
    const mgr = makeManager({
      fetchFn: fetchWithProfile,
      spawn: spawnEcho,
      config: { soft_threshold_tokens: 999999, hard_threshold_tokens: 9999999 },
    });

    const session = await mgr.create({
      workdir: tmpRoot,
      permission_profile_id: 99,
    });

    await waitForStatus(session, "live", 3000);

    let suggestionSeen = false;
    const unsub = session.subscribe((evt) => {
      if (evt.type === "compact_suggested") suggestionSeen = true;
    });

    // Trigger mock-cc to emit a result event with 100 input_tokens (> override threshold of 50)
    await session.writeInput("trigger compact");

    const deadline = Date.now() + 3000;
    while (!suggestionSeen && Date.now() < deadline) {
      await Bun.sleep(50);
    }

    unsub();
    expect(suggestionSeen).toBe(true);

    await mgr.endAll();
    await mgr.drainLifecycle();
  }, 10000);

  test("profile mutation after create does not change in-flight Compactor threshold", async () => {
    const lowThresholdProfile: PermissionProfile = {
      id: 88,
      name: "low-threshold",
      description: null,
      is_seed: false,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      rules: {
        auto_approve: [],
        always_prompt: [],
        deny: [],
        compact_overrides: { soft_threshold_tokens: 50 },
      },
    };

    const baseStub = makeSafirStub();
    const fetchWithProfile: FetchFn = async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path === "/permission-profiles/88") {
        return Response.json(lowThresholdProfile, { status: 200 });
      }
      return baseStub.fetch(input, init);
    };

    const mgr = makeManager({
      fetchFn: fetchWithProfile,
      spawn: spawnEcho,
      config: { soft_threshold_tokens: 999999, hard_threshold_tokens: 9999999 },
    });

    const session = await mgr.create({ workdir: tmpRoot, permission_profile_id: 88 });
    await waitForStatus(session, "live", 3000);

    // Mutate the session profile to a high threshold AFTER creation
    session.setPermissionProfile({
      ...lowThresholdProfile,
      id: 89,
      name: "high-threshold",
      rules: { ...lowThresholdProfile.rules, compact_overrides: { soft_threshold_tokens: 999999 } },
    });

    let suggestionSeen = false;
    const unsub = session.subscribe((evt) => {
      if (evt.type === "compact_suggested") suggestionSeen = true;
    });

    // The Compactor was built with threshold=50 at creation time; the mutation
    // should not change it. Result with 100 tokens should still suggest compact.
    await session.writeInput("trigger compact");
    const deadline = Date.now() + 3000;
    while (!suggestionSeen && Date.now() < deadline) {
      await Bun.sleep(50);
    }

    unsub();
    expect(suggestionSeen).toBe(true);

    await mgr.endAll();
    await mgr.drainLifecycle();
  }, 10000);
});

describe("runCompact compactor wiring", () => {
  test("initialMessage is sent to successor", async () => {
    const stub = makeSafirStub();
    const mgr = makeManager({ fetchFn: stub.fetch, spawn: spawnEcho });
    const session = await mgr.create({ workdir: tmpRoot, taskId: 42 });
    const oldSid = session.oakridgeSid;

    await mgr.runCompact(oldSid, { kind: "manual" });
    await mgr.drainLifecycle();

    const successor = mgr.list().find((s) => s.parentOakridgeSid === oldSid);
    expect(successor).toBeDefined();

    // Give the successor a moment to receive stdin and emit a result
    // event back. The mock-cc echoes a `result` for any line it reads,
    // so the successor's JSONL should contain at least one result event
    // shortly after writeInput(handoff.raw_markdown).
    const deadline = Date.now() + 3000;
    let successorEvents: Array<Record<string, unknown>> = [];
    while (Date.now() < deadline) {
      successorEvents = readJsonl(
        join(sessionsDir, `${successor!.oakridgeSid}.jsonl`),
      );
      if (successorEvents.some((e) => e.type === "result")) break;
      await Bun.sleep(50);
    }
    expect(successorEvents.some((e) => e.type === "result")).toBe(true);

    await mgr.endAll();
    await mgr.drainLifecycle();
  }, 15000);
});
