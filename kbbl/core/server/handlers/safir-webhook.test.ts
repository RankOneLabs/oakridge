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

let tmpRoot: string;
let sessionsDir: string;
let worktreesDir: string;

const TEST_TOKEN = "test-token-abc123";

interface SafirStubCall {
  method: string;
  path: string;
  body: unknown;
}

function makeSafirStub(): { fetch: FetchFn; calls: SafirStubCall[] } {
  const calls: SafirStubCall[] = [];
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
    if (method === "PATCH") {
      return Response.json({ id: path.split("/")[2], ...(body as object) }, { status: 200 });
    }
    return Response.json({ error: "stub: unhandled" }, { status: 404 });
  };
  return { fetch: fetchFn, calls };
}

function buildConfig(): KbblConfig {
  return KbblConfigSchema.parse({ sessions: { worktree_per_session: false } });
}

function hangingSpawn(_session: Session): SpawnCmd {
  return { cmd: ["cat"], cwd: "/tmp", env: {} };
}

function makeManager(fetchFn: FetchFn): SessionManager {
  const safirClient = createSafirClient({ baseUrl: "http://safir.test", fetch: fetchFn });
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

function buildApp(manager: SessionManager): Hono {
  const app = new Hono();
  mountSafirWebhookRoutes(app, { manager });
  return app;
}

function envelope(overrides: Partial<{
  event: string;
  ts: string;
  delivery_id: string;
  data: Record<string, unknown>;
}>): Record<string, unknown> {
  return {
    event: overrides.event ?? "run.completed",
    ts: overrides.ts ?? "2026-05-09T00:00:00.000Z",
    delivery_id: overrides.delivery_id ?? "delivery-1",
    data: overrides.data ?? { run_id: "no-match", task_id: 1, finished_at: "2026-05-09T00:00:01.000Z" },
  };
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kbbl-webhook-test-"));
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

describe("safir-webhook receiver", () => {
  test("dispatches run.completed onto the matching live session", async () => {
    const stub = makeSafirStub();
    const mgr = makeManager(stub.fetch);
    const session = await mgr.create({ workdir: "/tmp", taskId: 7 });
    const runId = session.runId;
    if (!runId) throw new Error("expected session.runId to be set after create");

    const captured: Array<{ type: string; payload: unknown }> = [];
    const unsubscribe = session.subscribe((evt) => {
      captured.push({ type: evt.type, payload: evt.payload });
    });

    const app = buildApp(mgr);
    const res = await app.fetch(
      new Request("http://kbbl.test/webhooks/safir", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TEST_TOKEN}`,
        },
        body: JSON.stringify(
          envelope({
            event: "run.completed",
            delivery_id: "delivery-test-1",
            data: { run_id: runId, task_id: 7, finished_at: "2026-05-09T00:00:01.000Z" },
          }),
        ),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; dispatched: boolean };
    expect(body).toEqual({ ok: true, dispatched: true });

    const safirEvents = captured.filter((e) => e.type === "safir_event");
    expect(safirEvents).toHaveLength(1);
    expect(safirEvents[0].payload).toMatchObject({
      event: "run.completed",
      delivery_id: "delivery-test-1",
      data: { run_id: runId, task_id: 7 },
    });

    unsubscribe();
    await mgr.endAll();
  });

  test("missing Authorization header returns 401", async () => {
    const stub = makeSafirStub();
    const mgr = makeManager(stub.fetch);
    const app = buildApp(mgr);

    const res = await app.fetch(
      new Request("http://kbbl.test/webhooks/safir", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(envelope({ delivery_id: "delivery-test-2" })),
      }),
    );

    expect(res.status).toBe(401);
  });

  test("wrong bearer token returns 401", async () => {
    const stub = makeSafirStub();
    const mgr = makeManager(stub.fetch);
    const app = buildApp(mgr);

    const res = await app.fetch(
      new Request("http://kbbl.test/webhooks/safir", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer wrong-token",
        },
        body: JSON.stringify(envelope({ delivery_id: "delivery-test-3" })),
      }),
    );

    expect(res.status).toBe(401);
  });

  test("unset SAFIR_WEBHOOK_TOKEN returns 401 (fail closed)", async () => {
    delete process.env.SAFIR_WEBHOOK_TOKEN;
    const stub = makeSafirStub();
    const mgr = makeManager(stub.fetch);
    const app = buildApp(mgr);

    const res = await app.fetch(
      new Request("http://kbbl.test/webhooks/safir", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TEST_TOKEN}`,
        },
        body: JSON.stringify(envelope({ delivery_id: "delivery-test-4" })),
      }),
    );

    expect(res.status).toBe(401);
  });

  test("duplicate delivery_id returns 200 with deduped:true and does not re-emit", async () => {
    const stub = makeSafirStub();
    const mgr = makeManager(stub.fetch);
    const session = await mgr.create({ workdir: "/tmp", taskId: 11 });
    const runId = session.runId;
    if (!runId) throw new Error("expected session.runId to be set after create");

    const captured: Array<{ type: string; payload: unknown }> = [];
    const unsubscribe = session.subscribe((evt) => {
      captured.push({ type: evt.type, payload: evt.payload });
    });

    const app = buildApp(mgr);
    const buildReq = (): Request =>
      new Request("http://kbbl.test/webhooks/safir", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TEST_TOKEN}`,
        },
        body: JSON.stringify(
          envelope({
            event: "run.completed",
            delivery_id: "delivery-dup",
            data: { run_id: runId, task_id: 11, finished_at: "2026-05-09T00:00:01.000Z" },
          }),
        ),
      });

    const first = await app.fetch(buildReq());
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { ok: boolean; dispatched?: boolean };
    expect(firstBody.dispatched).toBe(true);
    expect(captured.filter((e) => e.type === "safir_event")).toHaveLength(1);

    const second = await app.fetch(buildReq());
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { ok: boolean; deduped?: boolean };
    expect(secondBody.deduped).toBe(true);
    expect(captured.filter((e) => e.type === "safir_event")).toHaveLength(1);

    unsubscribe();
    await mgr.endAll();
  });

  test("dispatchable event with no live-session match returns 200 dispatched:false", async () => {
    const stub = makeSafirStub();
    const mgr = makeManager(stub.fetch);
    const app = buildApp(mgr);

    const res = await app.fetch(
      new Request("http://kbbl.test/webhooks/safir", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TEST_TOKEN}`,
        },
        body: JSON.stringify(
          envelope({
            event: "run.completed",
            delivery_id: "delivery-no-match",
            data: { run_id: "ghost-run-id", task_id: 1, finished_at: "2026-05-09T00:00:01.000Z" },
          }),
        ),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; dispatched: boolean };
    expect(body).toEqual({ ok: true, dispatched: false });
  });

  test("non-dispatched event type (run.created) returns 200 dispatched:false with no emission", async () => {
    const stub = makeSafirStub();
    const mgr = makeManager(stub.fetch);
    const session = await mgr.create({ workdir: "/tmp", taskId: 13 });
    const runId = session.runId;
    if (!runId) throw new Error("expected session.runId to be set after create");

    const captured: Array<{ type: string; payload: unknown }> = [];
    const unsubscribe = session.subscribe((evt) => {
      captured.push({ type: evt.type, payload: evt.payload });
    });

    const app = buildApp(mgr);
    const res = await app.fetch(
      new Request("http://kbbl.test/webhooks/safir", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TEST_TOKEN}`,
        },
        body: JSON.stringify(
          envelope({
            event: "run.created",
            delivery_id: "delivery-non-dispatch",
            data: { run_id: runId, task_id: 13, executor: "claude_code", status: "running" },
          }),
        ),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; dispatched: boolean };
    expect(body).toEqual({ ok: true, dispatched: false });
    expect(captured.filter((e) => e.type === "safir_event")).toHaveLength(0);

    unsubscribe();
    await mgr.endAll();
  });

  test("missing ts returns 400", async () => {
    const stub = makeSafirStub();
    const mgr = makeManager(stub.fetch);
    const app = buildApp(mgr);

    const res = await app.fetch(
      new Request("http://kbbl.test/webhooks/safir", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TEST_TOKEN}`,
        },
        body: JSON.stringify({
          event: "run.completed",
          delivery_id: "delivery-no-ts",
          data: { run_id: "any", task_id: 1, finished_at: "2026-05-09T00:00:01.000Z" },
        }),
      }),
    );

    expect(res.status).toBe(400);
  });

  test("fan-out: two live sessions sharing a runId both receive safir_event", async () => {
    const stub = makeSafirStub();
    const mgr = makeManager(stub.fetch);
    const first = await mgr.create({ workdir: "/tmp", taskId: 17 });
    const sharedRunId = first.runId;
    if (!sharedRunId) throw new Error("expected first.runId to be set after create");
    const second = await mgr.create({ workdir: "/tmp", runId: sharedRunId });
    if (second.runId !== sharedRunId) throw new Error("expected second session to attach to shared runId");

    const firstEvents: Array<{ type: string; payload: unknown }> = [];
    const secondEvents: Array<{ type: string; payload: unknown }> = [];
    const unsub1 = first.subscribe((evt) => firstEvents.push({ type: evt.type, payload: evt.payload }));
    const unsub2 = second.subscribe((evt) => secondEvents.push({ type: evt.type, payload: evt.payload }));

    const app = buildApp(mgr);
    const res = await app.fetch(
      new Request("http://kbbl.test/webhooks/safir", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TEST_TOKEN}`,
        },
        body: JSON.stringify(
          envelope({
            event: "run.completed",
            delivery_id: "delivery-fanout",
            data: { run_id: sharedRunId, task_id: 17, finished_at: "2026-05-09T00:00:01.000Z" },
          }),
        ),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; dispatched: boolean };
    expect(body).toEqual({ ok: true, dispatched: true });
    expect(firstEvents.filter((e) => e.type === "safir_event")).toHaveLength(1);
    expect(secondEvents.filter((e) => e.type === "safir_event")).toHaveLength(1);

    unsub1();
    unsub2();
    await mgr.endAll();
  });

  test("unknown event type returns 200 dispatched:false (logged as event_unknown)", async () => {
    const stub = makeSafirStub();
    const mgr = makeManager(stub.fetch);
    const app = buildApp(mgr);

    const res = await app.fetch(
      new Request("http://kbbl.test/webhooks/safir", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TEST_TOKEN}`,
        },
        body: JSON.stringify(
          envelope({
            event: "phase.created" as unknown as string,
            delivery_id: "delivery-unknown-event",
            data: { run_id: "any", task_id: 1 },
          }),
        ),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; dispatched: boolean };
    expect(body).toEqual({ ok: true, dispatched: false });
  });

  test("malformed JSON and array bodies return 400", async () => {
    const stub = makeSafirStub();
    const mgr = makeManager(stub.fetch);
    const app = buildApp(mgr);

    const badJson = await app.fetch(
      new Request("http://kbbl.test/webhooks/safir", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TEST_TOKEN}`,
        },
        body: "not json",
      }),
    );
    expect(badJson.status).toBe(400);

    const arrayBody = await app.fetch(
      new Request("http://kbbl.test/webhooks/safir", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TEST_TOKEN}`,
        },
        body: JSON.stringify([]),
      }),
    );
    expect(arrayBody.status).toBe(400);
  });
});
