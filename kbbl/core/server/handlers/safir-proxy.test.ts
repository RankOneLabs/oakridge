import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { SafirHttpError, type SafirClient } from "../../safir/client";
import type {
  HandoffDocRecord,
  Task,
} from "../../safir/types";
import { mountSafirProxyRoutes } from "./safir-proxy";

interface StubCall {
  method: keyof SafirClient;
  args: unknown[];
}

interface StubOpts {
  listTasks?: () => Promise<Task[]>;
  getTask?: (taskId: number) => Promise<Task>;
  listHandoffsForTask?: (taskId: number) => Promise<HandoffDocRecord[]>;
  getHandoff?: (handoffId: string) => Promise<HandoffDocRecord>;
}

function makeStubClient(opts: StubOpts): {
  client: SafirClient;
  calls: StubCall[];
} {
  const calls: StubCall[] = [];
  const notImplemented = (name: keyof SafirClient) => async () => {
    throw new Error(`stub: ${String(name)} not configured for this test`);
  };
  const wrap =
    <K extends keyof SafirClient>(
      name: K,
      impl: ((...args: never[]) => unknown) | undefined,
    ) =>
    async (...args: unknown[]) => {
      calls.push({ method: name, args });
      if (!impl) return notImplemented(name)();
      return (impl as (...a: unknown[]) => unknown)(...args);
    };
  const client: SafirClient = {
    createRun: notImplemented("createRun") as SafirClient["createRun"],
    updateRun: notImplemented("updateRun") as SafirClient["updateRun"],
    abandonRun: notImplemented("abandonRun") as SafirClient["abandonRun"],
    createPhase: notImplemented("createPhase") as SafirClient["createPhase"],
    updatePhase: notImplemented("updatePhase") as SafirClient["updatePhase"],
    submitHandoff: notImplemented(
      "submitHandoff",
    ) as SafirClient["submitHandoff"],
    listTasks: wrap("listTasks", opts.listTasks) as SafirClient["listTasks"],
    getTask: wrap("getTask", opts.getTask) as SafirClient["getTask"],
    listHandoffsForTask: wrap(
      "listHandoffsForTask",
      opts.listHandoffsForTask,
    ) as SafirClient["listHandoffsForTask"],
    getHandoff: wrap("getHandoff", opts.getHandoff) as SafirClient["getHandoff"],
  };
  return { client, calls };
}

function buildApp(client: SafirClient): Hono {
  const app = new Hono();
  mountSafirProxyRoutes(app, { safirClient: client });
  return app;
}

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: 1,
    project_id: "proj-1",
    parent_id: null,
    title: "stub task",
    status: "open",
    ...over,
  };
}

function makeHandoff(over: Partial<HandoffDocRecord> = {}): HandoffDocRecord {
  return {
    id: "stub-handoff-1",
    phase_id: "phase-1",
    run_id: "run-1",
    role: "phase_output",
    schema_version: 1,
    goal: "carry forward",
    active_subgoals: [],
    decisions_made: [],
    approaches_rejected: [],
    files_in_scope: [],
    open_questions: [],
    next_action: null,
    raw_markdown: "# handoff\n\nsome content",
    produced_at: "2026-05-09T00:00:00.000Z",
    ...over,
  };
}


describe("safir-proxy GET /safir/tasks/:taskId", () => {
  test("forwards to safirClient.getTask and returns the task body", async () => {
    const expected = makeTask({ id: 42, title: "specific" });
    const { client, calls } = makeStubClient({
      getTask: async () => expected,
    });
    const app = buildApp(client);

    const res = await app.fetch(
      new Request("http://kbbl.test/safir/tasks/42"),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(expected);
    expect(calls).toEqual([{ method: "getTask", args: [42] }]);
  });

  test("rejects non-numeric taskId with 400 and no upstream call", async () => {
    const { client, calls } = makeStubClient({});
    const app = buildApp(client);

    const res = await app.fetch(
      new Request("http://kbbl.test/safir/tasks/abc"),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "taskId must be a positive integer" });
    expect(calls.length).toBe(0);
  });

  test("upstream SafirHttpError(404) passes status through", async () => {
    const { client, calls } = makeStubClient({
      getTask: async () => {
        throw new SafirHttpError(404, { error: "task not found" });
      },
    });
    const app = buildApp(client);

    const res = await app.fetch(
      new Request("http://kbbl.test/safir/tasks/999"),
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "safir HTTP 404",
      status: 404,
      body: { error: "task not found" },
    });
    expect(calls).toEqual([{ method: "getTask", args: [999] }]);
  });

  test("network failure on getTask becomes 502", async () => {
    const { client } = makeStubClient({
      getTask: async () => {
        throw new TypeError("fetch failed");
      },
    });
    const app = buildApp(client);

    const res = await app.fetch(
      new Request("http://kbbl.test/safir/tasks/1"),
    );

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "safir unreachable" });
  });
});

describe("safir-proxy GET /safir/tasks", () => {
  test("returns the listTasks array", async () => {
    const tasks = [makeTask({ id: 1 }), makeTask({ id: 2 })];
    const { client, calls } = makeStubClient({
      listTasks: async () => tasks,
    });
    const app = buildApp(client);

    const res = await app.fetch(
      new Request("http://kbbl.test/safir/tasks"),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(tasks);
    expect(calls).toEqual([{ method: "listTasks", args: [] }]);
  });
});

describe("safir-proxy GET /safir/tasks/:taskId/handoffs", () => {
  test("returns the handoff list", async () => {
    const handoffs = [makeHandoff({ id: "h1" }), makeHandoff({ id: "h2" })];
    const { client, calls } = makeStubClient({
      listHandoffsForTask: async () => handoffs,
    });
    const app = buildApp(client);

    const res = await app.fetch(
      new Request("http://kbbl.test/safir/tasks/7/handoffs"),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as HandoffDocRecord[];
    expect(body.length).toBe(2);
    expect(body[1].id).toBe("h2");
    expect(calls).toEqual([{ method: "listHandoffsForTask", args: [7] }]);
  });

  test("rejects non-numeric taskId without upstream call", async () => {
    const { client, calls } = makeStubClient({
      listHandoffsForTask: async () => {
        throw new Error("stub: should not be called");
      },
    });
    const app = buildApp(client);

    const res = await app.fetch(
      new Request("http://kbbl.test/safir/tasks/abc/handoffs"),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "taskId must be a positive integer" });
    expect(calls.length).toBe(0);
  });
});

describe("safir-proxy GET /safir/handoffs/:handoffId", () => {
  test("returns a single handoff", async () => {
    const handoff = makeHandoff({ id: "deadbeef" });
    const { client, calls } = makeStubClient({
      getHandoff: async () => handoff,
    });
    const app = buildApp(client);

    const res = await app.fetch(
      new Request("http://kbbl.test/safir/handoffs/deadbeef"),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as HandoffDocRecord;
    expect(body.id).toBe("deadbeef");
    expect(body.raw_markdown).toBeTruthy();
    expect(calls).toEqual([{ method: "getHandoff", args: ["deadbeef"] }]);
  });
});
