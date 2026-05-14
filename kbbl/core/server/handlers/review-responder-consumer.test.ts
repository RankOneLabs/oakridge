import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

import { KbblConfigSchema, type KbblConfig } from "../../config";
import { createSafirClient, type FetchFn } from "../../safir/client";
import { createSafirQueue } from "../../safir/queue";
import { SessionManager } from "../../session/session-manager";
import type { Session, SpawnCmd } from "../../session/session";
import { mountSafirWebhookRoutes } from "./safir-webhook";
import {
  dispatchReviewResponder,
  type ReviewResponderSubprocessResult,
  type SpawnAgentFn,
  type SpawnOpts,
} from "./review-responder-consumer";

const TEST_TOKEN = "test-token-responder";

let tmpRoot: string;
let sessionsDir: string;
let worktreesDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kbbl-responder-test-"));
  sessionsDir = join(tmpRoot, "sessions");
  worktreesDir = join(tmpRoot, "worktrees");
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(worktreesDir, { recursive: true });
  process.env.SAFIR_WEBHOOK_TOKEN = TEST_TOKEN;
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.SAFIR_WEBHOOK_TOKEN;
});

// ---------------------------------------------------------------------------
// Safir stub helpers
// ---------------------------------------------------------------------------

interface StubCall {
  method: string;
  path: string;
  body: unknown;
}

interface SafirStub {
  fetch: FetchFn;
  calls: StubCall[];
}

function makeSafirStub(extraHandlers?: (path: string, method: string, body: unknown) => Response | null): SafirStub {
  const calls: StubCall[] = [];
  let nextId = 1;
  const fetchFn: FetchFn = async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const method = (init?.method ?? "GET").toUpperCase();
    const bodyText = typeof init?.body === "string" ? init.body : null;
    const body = bodyText ? (JSON.parse(bodyText) as unknown) : null;
    calls.push({ method, path, body });

    if (extraHandlers) {
      const r = extraHandlers(path, method, body);
      if (r) return r;
    }

    const id = `stub-${nextId++}`;

    // Review responder endpoints
    if (method === "GET" && /^\/threads\//.test(path)) {
      return Response.json({
        id: path.split("/")[2],
        target_type: "plan",
        target_id: "plan-1",
        anchor: "cohorts[0]",
        status: "open",
        agent_responding: 1,
        resolved_at: null,
        created_at: "2026-01-01T00:00:00Z",
        messages: [{ id: "m1", thread_id: path.split("/")[2], author: "op", body: "Ping", related_edit_id: null, created_at: "2026-01-01T00:00:00Z" }],
      });
    }
    if (method === "GET" && /^\/atoms\//.test(path)) {
      return Response.json({ "cohorts[0].title": "Cohort Zero", "cohorts[0].priority": "1" });
    }
    if (method === "GET" && /\/threads\?status=open/.test(path)) {
      return Response.json([]);
    }
    if (method === "GET" && /^\/plans\//.test(path)) {
      return Response.json({ id: path.split("/")[2], parent_task_id: 42, status: "pending_approval" });
    }
    if (method === "GET" && /^\/tasks\//.test(path)) {
      return Response.json({ id: Number(path.split("/")[2]), title: "Parent task", notes: "Build it.", project_id: "p1", parent_id: null, status: "open" });
    }
    if (method === "POST" && /\/agent-response$/.test(path)) {
      return Response.json({ ok: true });
    }
    if (method === "POST" && /^\/tasks\/\d+\/runs$/.test(path)) {
      return Response.json({ id, ...(body as object) }, { status: 201 });
    }
    if (method === "POST" && /^\/runs\/[^/]+\/phases$/.test(path)) {
      return Response.json({ id, ...(body as object) }, { status: 201 });
    }
    if (method === "PATCH") {
      return Response.json({ id: path.split("/")[2], ...(body as object) });
    }
    return Response.json({ error: "stub: unhandled" }, { status: 404 });
  };
  return { fetch: fetchFn, calls };
}

function buildConfig(): KbblConfig {
  return KbblConfigSchema.parse({ sessions: { worktree_per_session: false } });
}

async function hangingSpawn(_session: Session): Promise<SpawnCmd> {
  return { cmd: ["cat"], cwd: "/tmp", env: {} };
}

function makeManager(fetchFn: FetchFn): SessionManager {
  const safirClient = createSafirClient({ baseUrl: "http://safir.test", fetch: fetchFn });
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

function webhookBody(overrides: Partial<{
  event: string;
  delivery_id: string;
  data: Record<string, unknown>;
}>): Record<string, unknown> {
  return {
    event: overrides.event ?? "thread.agent_response_started",
    ts: "2026-05-13T00:00:00.000Z",
    delivery_id: overrides.delivery_id ?? "delivery-1",
    data: overrides.data ?? {
      thread_id: "thread-1",
      target_type: "plan",
      target_id: "plan-1",
      anchor: "cohorts[0]",
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("review-responder-consumer", () => {
  test("dispatches thread.agent_response_started: invokes subprocess with correct args and posts agent-response", async () => {
    const stub = makeSafirStub();
    const mgr = makeManager(stub.fetch);

    const spawnCalls: SpawnOpts[] = [];
    const stubSpawn: SpawnAgentFn = async (opts) => {
      spawnCalls.push(opts);
      const result: ReviewResponderSubprocessResult = {
        status: "completed",
        reply_message_id: "msg-reply-1",
        conflicts: [],
      };
      return result;
    };

    const safirClient = createSafirClient({ baseUrl: "http://safir.test", fetch: stub.fetch });
    const app = new Hono();
    mountSafirWebhookRoutes(app, {
      manager: mgr,
      reviewResponder: {
        safirClient,
        safirBaseUrl: "http://safir.test",
        pythonBin: "python3",
        spawnAgent: stubSpawn,
      },
    });

    const res = await app.fetch(
      new Request("http://kbbl.test/webhooks/safir", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TEST_TOKEN}`,
        },
        body: JSON.stringify(
          webhookBody({
            delivery_id: "delivery-responder-1",
            data: {
              thread_id: "thread-42",
              target_type: "plan",
              target_id: "plan-99",
              anchor: "cohorts[0]",
            },
          }),
        ),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; dispatched: boolean };
    expect(body).toEqual({ ok: true, dispatched: true });

    // Wait briefly for the fire-and-forget promise to settle.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Subprocess was invoked with correct args.
    expect(spawnCalls).toHaveLength(1);
    const spawnCall = spawnCalls[0];
    expect(spawnCall.cmd).toContain("python3");
    expect(spawnCall.cmd).toContain("-m");
    expect(spawnCall.cmd).toContain("builder.review_responder_runner");
    expect(spawnCall.cmd).toContain("--target-type");
    expect(spawnCall.cmd).toContain("plan");
    expect(spawnCall.cmd).toContain("--target-id");
    expect(spawnCall.cmd).toContain("plan-99");
    expect(spawnCall.cmd).toContain("--thread-id");
    expect(spawnCall.cmd).toContain("thread-42");
    expect(spawnCall.cmd).toContain("--safir-base-url");
    expect(spawnCall.cmd).toContain("http://safir.test");

    // Context payload was passed via stdin.
    const ctxPayload = JSON.parse(spawnCall.stdinPayload) as Record<string, unknown>;
    expect(ctxPayload.target_type).toBe("plan");
    expect(ctxPayload.target_id).toBe("plan-99");
    expect(ctxPayload.thread_id).toBe("thread-42");
    expect(ctxPayload.atom_map).toBeDefined();

    // agent-response was POSTed back to safir.
    const agentResponseCall = stub.calls.find(
      (c) => c.method === "POST" && c.path.includes("/agent-response"),
    );
    expect(agentResponseCall).toBeDefined();
    expect((agentResponseCall?.body as Record<string, unknown>)?.status).toBe("completed");
    expect((agentResponseCall?.body as Record<string, unknown>)?.reply_message_id).toBe("msg-reply-1");

    await mgr.endAll();
  });

  test("reports failed status when subprocess returns failed", async () => {
    const stub = makeSafirStub();
    const mgr = makeManager(stub.fetch);

    const stubSpawn: SpawnAgentFn = async () => ({
      status: "failed",
      error: "agent crashed",
      conflicts: [],
    });

    const safirClient = createSafirClient({ baseUrl: "http://safir.test", fetch: stub.fetch });
    const app = new Hono();
    mountSafirWebhookRoutes(app, {
      manager: mgr,
      reviewResponder: {
        safirClient,
        safirBaseUrl: "http://safir.test",
        spawnAgent: stubSpawn,
      },
    });

    await app.fetch(
      new Request("http://kbbl.test/webhooks/safir", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TEST_TOKEN}`,
        },
        body: JSON.stringify(webhookBody({ delivery_id: "delivery-failed-1" })),
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 50));

    const agentResponseCall = stub.calls.find(
      (c) => c.method === "POST" && c.path.includes("/agent-response"),
    );
    expect(agentResponseCall).toBeDefined();
    expect((agentResponseCall?.body as Record<string, unknown>)?.status).toBe("failed");
    expect((agentResponseCall?.body as Record<string, unknown>)?.error).toBe("agent crashed");

    await mgr.endAll();
  });

  test("no-op when reviewResponder deps are not provided", async () => {
    const stub = makeSafirStub();
    const mgr = makeManager(stub.fetch);

    // Mount WITHOUT reviewResponder — should log drop + return dispatched:false
    const app = new Hono();
    mountSafirWebhookRoutes(app, { manager: mgr });

    const res = await app.fetch(
      new Request("http://kbbl.test/webhooks/safir", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TEST_TOKEN}`,
        },
        body: JSON.stringify(webhookBody({ delivery_id: "delivery-no-deps-1" })),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; dispatched: boolean };
    expect(body).toEqual({ ok: true, dispatched: false });

    // No agent-response call should have happened.
    const agentResponseCall = stub.calls.find(
      (c) => c.method === "POST" && c.path.includes("/agent-response"),
    );
    expect(agentResponseCall).toBeUndefined();

    await mgr.endAll();
  });

  // ---------------------------------------------------------------------------
  // loadDependencyBriefsNotes cases
  // ---------------------------------------------------------------------------

  test("build_brief with no deps: dependency_briefs_notes is []", async () => {
    const stub = makeSafirStub((path, method) => {
      if (method === "GET" && /^\/build-briefs\/brief-nodeps$/.test(path)) {
        return Response.json({ id: "brief-nodeps", task_id: 20, status: "approved" });
      }
      if (method === "GET" && /^\/tasks\/20\/dependencies$/.test(path)) {
        return Response.json([]);
      }
      // Override thread to point at build_brief
      if (method === "GET" && /^\/threads\//.test(path)) {
        return Response.json({ id: "thread-bd", target_type: "build_brief", target_id: "brief-nodeps", anchor: null, status: "open", agent_responding: 1, created_at: "2026-01-01T00:00:00Z", messages: [] });
      }
      if (method === "GET" && /^\/atoms\/build_brief\//.test(path)) {
        return Response.json({});
      }
      if (method === "GET" && /\/threads\?/.test(path)) {
        return Response.json([]);
      }
      return null;
    });

    const safirClient = createSafirClient({ baseUrl: "http://safir.test", fetch: stub.fetch });
    const spawnCalls: SpawnOpts[] = [];
    const stubSpawn: SpawnAgentFn = async (opts) => { spawnCalls.push(opts); return { status: "completed", conflicts: [] }; };

    await dispatchReviewResponder(
      { thread_id: "thread-bd", target_type: "build_brief", target_id: "brief-nodeps", anchor: null },
      { safirClient, safirBaseUrl: "http://safir.test", spawnAgent: stubSpawn },
    );

    expect(spawnCalls).toHaveLength(1);
    const ctx = JSON.parse(spawnCalls[0].stdinPayload) as Record<string, unknown>;
    expect(ctx.dependency_briefs_notes).toEqual([]);
  });

  test("build_brief with two deps, both with approved handoffs: notes array length 2 in order", async () => {
    const stub = makeSafirStub((path, method) => {
      if (method === "GET" && /^\/build-briefs\/brief-2deps$/.test(path)) {
        return Response.json({ id: "brief-2deps", task_id: 30, status: "approved" });
      }
      if (method === "GET" && /^\/tasks\/30\/dependencies$/.test(path)) {
        return Response.json([{ depends_on: 31 }, { depends_on: 32 }]);
      }
      if (method === "GET" && /^\/tasks\/31\/handoffs$/.test(path)) {
        return Response.json([
          { id: "h31", status: "approved", produced_at: "2026-01-02T00:00:00Z", raw_markdown: "notes-dep-31" },
        ]);
      }
      if (method === "GET" && /^\/tasks\/32\/handoffs$/.test(path)) {
        return Response.json([
          { id: "h32", status: "approved", produced_at: "2026-01-03T00:00:00Z", raw_markdown: "notes-dep-32" },
        ]);
      }
      if (method === "GET" && /^\/threads\//.test(path)) {
        return Response.json({ id: "thread-2d", target_type: "build_brief", target_id: "brief-2deps", anchor: null, status: "open", agent_responding: 1, created_at: "2026-01-01T00:00:00Z", messages: [] });
      }
      if (method === "GET" && /^\/atoms\/build_brief\//.test(path)) {
        return Response.json({});
      }
      if (method === "GET" && /\/threads\?/.test(path)) {
        return Response.json([]);
      }
      return null;
    });

    const safirClient = createSafirClient({ baseUrl: "http://safir.test", fetch: stub.fetch });
    const spawnCalls: SpawnOpts[] = [];
    const stubSpawn: SpawnAgentFn = async (opts) => { spawnCalls.push(opts); return { status: "completed", conflicts: [] }; };

    await dispatchReviewResponder(
      { thread_id: "thread-2d", target_type: "build_brief", target_id: "brief-2deps", anchor: null },
      { safirClient, safirBaseUrl: "http://safir.test", spawnAgent: stubSpawn },
    );

    expect(spawnCalls).toHaveLength(1);
    const ctx = JSON.parse(spawnCalls[0].stdinPayload) as Record<string, unknown>;
    expect(ctx.dependency_briefs_notes).toEqual(["notes-dep-31", "notes-dep-32"]);
  });

  test("build_brief with deps but no approved handoff: notes is []", async () => {
    const stub = makeSafirStub((path, method) => {
      if (method === "GET" && /^\/build-briefs\/brief-noapproved$/.test(path)) {
        return Response.json({ id: "brief-noapproved", task_id: 40, status: "approved" });
      }
      if (method === "GET" && /^\/tasks\/40\/dependencies$/.test(path)) {
        return Response.json([{ depends_on: 41 }]);
      }
      if (method === "GET" && /^\/tasks\/41\/handoffs$/.test(path)) {
        return Response.json([
          { id: "h41", status: "pending_approval", produced_at: "2026-01-01T00:00:00Z", raw_markdown: "draft-notes" },
        ]);
      }
      if (method === "GET" && /^\/threads\//.test(path)) {
        return Response.json({ id: "thread-na", target_type: "build_brief", target_id: "brief-noapproved", anchor: null, status: "open", agent_responding: 1, created_at: "2026-01-01T00:00:00Z", messages: [] });
      }
      if (method === "GET" && /^\/atoms\/build_brief\//.test(path)) {
        return Response.json({});
      }
      if (method === "GET" && /\/threads\?/.test(path)) {
        return Response.json([]);
      }
      return null;
    });

    const safirClient = createSafirClient({ baseUrl: "http://safir.test", fetch: stub.fetch });
    const spawnCalls: SpawnOpts[] = [];
    const stubSpawn: SpawnAgentFn = async (opts) => { spawnCalls.push(opts); return { status: "completed", conflicts: [] }; };

    await dispatchReviewResponder(
      { thread_id: "thread-na", target_type: "build_brief", target_id: "brief-noapproved", anchor: null },
      { safirClient, safirBaseUrl: "http://safir.test", spawnAgent: stubSpawn },
    );

    expect(spawnCalls).toHaveLength(1);
    const ctx = JSON.parse(spawnCalls[0].stdinPayload) as Record<string, unknown>;
    expect(ctx.dependency_briefs_notes).toEqual([]);
  });

  test("plan target: dependency_briefs_notes is null", async () => {
    const stub = makeSafirStub();
    const safirClient = createSafirClient({ baseUrl: "http://safir.test", fetch: stub.fetch });
    const spawnCalls: SpawnOpts[] = [];
    const stubSpawn: SpawnAgentFn = async (opts) => { spawnCalls.push(opts); return { status: "completed", conflicts: [] }; };

    await dispatchReviewResponder(
      { thread_id: "thread-1", target_type: "plan", target_id: "plan-1", anchor: "cohorts[0]" },
      { safirClient, safirBaseUrl: "http://safir.test", spawnAgent: stubSpawn },
    );

    expect(spawnCalls).toHaveLength(1);
    const ctx = JSON.parse(spawnCalls[0].stdinPayload) as Record<string, unknown>;
    expect(ctx.dependency_briefs_notes).toBeNull();
  });

  test("safir error during dep load: dispatch continues with dependency_briefs_notes null", async () => {
    const stub = makeSafirStub((path, method) => {
      if (method === "GET" && /^\/build-briefs\/brief-err$/.test(path)) {
        return Response.json({ error: "server error" }, { status: 500 });
      }
      if (method === "GET" && /^\/threads\//.test(path)) {
        return Response.json({ id: "thread-err", target_type: "build_brief", target_id: "brief-err", anchor: null, status: "open", agent_responding: 1, created_at: "2026-01-01T00:00:00Z", messages: [] });
      }
      if (method === "GET" && /^\/atoms\/build_brief\//.test(path)) {
        return Response.json({});
      }
      if (method === "GET" && /\/threads\?/.test(path)) {
        return Response.json([]);
      }
      return null;
    });

    const safirClient = createSafirClient({ baseUrl: "http://safir.test", fetch: stub.fetch });
    const spawnCalls: SpawnOpts[] = [];
    const stubSpawn: SpawnAgentFn = async (opts) => { spawnCalls.push(opts); return { status: "completed", conflicts: [] }; };

    await dispatchReviewResponder(
      { thread_id: "thread-err", target_type: "build_brief", target_id: "brief-err", anchor: null },
      { safirClient, safirBaseUrl: "http://safir.test", spawnAgent: stubSpawn },
    );

    // Dispatch should still succeed despite dep-load error.
    expect(spawnCalls).toHaveLength(1);
    const ctx = JSON.parse(spawnCalls[0].stdinPayload) as Record<string, unknown>;
    expect(ctx.dependency_briefs_notes).toBeNull();
  });

  test("existing run.completed fanout still works after consumer addition", async () => {
    const stub = makeSafirStub();
    const mgr = makeManager(stub.fetch);
    const session = await mgr.create({ workdir: "/tmp", taskId: 55 });
    const runId = session.runId;
    if (!runId) throw new Error("expected runId");

    const captured: { type: string }[] = [];
    const unsub = session.subscribe((evt) => captured.push({ type: evt.type }));

    const app = new Hono();
    mountSafirWebhookRoutes(app, { manager: mgr });

    const res = await app.fetch(
      new Request("http://kbbl.test/webhooks/safir", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TEST_TOKEN}`,
        },
        body: JSON.stringify({
          event: "run.completed",
          ts: "2026-05-13T00:00:00.000Z",
          delivery_id: "delivery-run-completed",
          data: { run_id: runId, task_id: 55, finished_at: "2026-05-13T00:00:01.000Z" },
        }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; dispatched: boolean };
    expect(body).toEqual({ ok: true, dispatched: true });
    expect(captured.filter((e) => e.type === "safir_event")).toHaveLength(1);

    unsub();
    await mgr.endAll();
  });
});
