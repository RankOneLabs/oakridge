import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { SafirHttpError, type SafirClient } from "../../safir/client";
import type {
  HandoffDocRecord,
  PermissionProfile,
  Plan,
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
  listPermissionProfiles?: () => Promise<PermissionProfile[]>;
  getPermissionProfile?: (id: number) => Promise<PermissionProfile>;
  listPlansForTask?: (taskId: number) => Promise<Plan[]>;
  getPlan?: (planId: string) => Promise<Plan>;
  updatePlanStatus?: (planId: string, body: { status: string; rejection_reason?: string | null }) => Promise<Plan>;
  reopenPlan?: (planId: string) => Promise<Plan>;
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
    listPermissionProfiles: wrap("listPermissionProfiles", opts.listPermissionProfiles) as SafirClient["listPermissionProfiles"],
    getPermissionProfile: wrap("getPermissionProfile", opts.getPermissionProfile) as SafirClient["getPermissionProfile"],
    createPermissionProfile: notImplemented("createPermissionProfile") as SafirClient["createPermissionProfile"],
    updatePermissionProfile: notImplemented("updatePermissionProfile") as SafirClient["updatePermissionProfile"],
    setTaskDefaultPermissionProfile: notImplemented("setTaskDefaultPermissionProfile") as SafirClient["setTaskDefaultPermissionProfile"],
    createTask: notImplemented("createTask") as SafirClient["createTask"],
    addDependency: notImplemented("addDependency") as SafirClient["addDependency"],
    listPlansForTask: wrap("listPlansForTask", opts.listPlansForTask) as SafirClient["listPlansForTask"],
    getPlan: wrap("getPlan", opts.getPlan) as SafirClient["getPlan"],
    updatePlanStatus: wrap("updatePlanStatus", opts.updatePlanStatus) as SafirClient["updatePlanStatus"],
    reopenPlan: wrap("reopenPlan", opts.reopenPlan) as SafirClient["reopenPlan"],
    getThread: notImplemented("getThread") as SafirClient["getThread"],
    getAtomMap: notImplemented("getAtomMap") as SafirClient["getAtomMap"],
    listOpenThreads: notImplemented("listOpenThreads") as SafirClient["listOpenThreads"],
    postAgentResponse: notImplemented("postAgentResponse") as SafirClient["postAgentResponse"],
    listAllThreads: notImplemented("listAllThreads") as SafirClient["listAllThreads"],
    listAtomHistory: notImplemented("listAtomHistory") as SafirClient["listAtomHistory"],
    postAtomEdit: notImplemented("postAtomEdit") as SafirClient["postAtomEdit"],
    createThread: notImplemented("createThread") as SafirClient["createThread"],
    postThreadMessage: notImplemented("postThreadMessage") as SafirClient["postThreadMessage"],
    pingThread: notImplemented("pingThread") as SafirClient["pingThread"],
    updateThreadStatus: notImplemented("updateThreadStatus") as SafirClient["updateThreadStatus"],
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

function makePermissionProfile(over: Partial<PermissionProfile> = {}): PermissionProfile {
  return {
    id: 1,
    name: "stub profile",
    description: null,
    is_seed: false,
    rules: {
      auto_approve: [],
      always_prompt: [],
      deny: [],
    },
    created_at: "2026-05-11T00:00:00.000Z",
    updated_at: "2026-05-11T00:00:00.000Z",
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

  test("timeout on getTask becomes 502", async () => {
    const { client } = makeStubClient({
      getTask: async () => {
        const err = new DOMException("signal timed out", "TimeoutError");
        throw err;
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

  test("rejects whitespace-only handoffId with 400 and no upstream call", async () => {
    const { client, calls } = makeStubClient({});
    const app = buildApp(client);

    const res = await app.fetch(
      new Request("http://kbbl.test/safir/handoffs/%20"),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "handoffId must be a non-empty string" });
    expect(calls.length).toBe(0);
  });
});

describe("safir-proxy GET /safir/permission-profiles", () => {
  test("returns the listPermissionProfiles array", async () => {
    const profiles = [
      makePermissionProfile({ id: 1, name: "default" }),
      makePermissionProfile({ id: 2, name: "strict" }),
    ];
    const { client, calls } = makeStubClient({
      listPermissionProfiles: async () => profiles,
    });
    const app = buildApp(client);

    const res = await app.fetch(
      new Request("http://kbbl.test/safir/permission-profiles"),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(profiles);
    expect(calls).toEqual([{ method: "listPermissionProfiles", args: [] }]);
  });

  test("safir-down 502 when listPermissionProfiles throws SafirHttpError(502)", async () => {
    const { client } = makeStubClient({
      listPermissionProfiles: async () => {
        throw new SafirHttpError(502, "bad gateway");
      },
    });
    const app = buildApp(client);

    const res = await app.fetch(
      new Request("http://kbbl.test/safir/permission-profiles"),
    );

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "safir HTTP 502",
      status: 502,
      body: "bad gateway",
    });
  });
});

describe("safir-proxy GET /safir/permission-profiles/:id", () => {
  test("returns a single profile", async () => {
    const profile = makePermissionProfile({ id: 7, name: "custom" });
    const { client, calls } = makeStubClient({
      getPermissionProfile: async () => profile,
    });
    const app = buildApp(client);

    const res = await app.fetch(
      new Request("http://kbbl.test/safir/permission-profiles/7"),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(profile);
    expect(calls).toEqual([{ method: "getPermissionProfile", args: [7] }]);
  });

  test("non-numeric id returns 400", async () => {
    const { client, calls } = makeStubClient({});
    const app = buildApp(client);

    const res = await app.fetch(
      new Request("http://kbbl.test/safir/permission-profiles/foo"),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/invalid permission profile id/);
    expect(calls.length).toBe(0);
  });

  test("SafirHttpError(404) passes status through", async () => {
    const { client } = makeStubClient({
      getPermissionProfile: async () => {
        throw new SafirHttpError(404, { error: "not found" });
      },
    });
    const app = buildApp(client);

    const res = await app.fetch(
      new Request("http://kbbl.test/safir/permission-profiles/999"),
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "safir HTTP 404",
      status: 404,
      body: { error: "not found" },
    });
  });

  test("generic Error becomes 502", async () => {
    const { client } = makeStubClient({
      getPermissionProfile: async () => {
        throw new TypeError("fetch failed");
      },
    });
    const app = buildApp(client);

    const res = await app.fetch(
      new Request("http://kbbl.test/safir/permission-profiles/1"),
    );

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "safir unreachable" });
  });
});

function makePlan(over: Partial<Plan> = {}): Plan {
  return {
    id: "plan-1",
    parent_task_id: 1,
    summary: "stub plan",
    model: "claude-opus-4-7",
    status: "pending_approval",
    rejection_reason: null,
    created_at: "2026-05-13T00:00:00.000Z",
    updated_at: "2026-05-13T00:00:00.000Z",
    cohorts: [],
    dependencies: [],
    ...over,
  };
}

describe("safir-proxy GET /safir/tasks/:taskId/plans", () => {
  test("returns plan list from safirClient.listPlansForTask", async () => {
    const plan = makePlan({ id: "plan-abc" });
    const { client, calls } = makeStubClient({
      listPlansForTask: async () => [plan],
    });
    const res = await buildApp(client).fetch(
      new Request("http://kbbl.test/safir/tasks/42/plans"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([plan]);
    expect(calls).toEqual([{ method: "listPlansForTask", args: [42] }]);
  });

  test("non-numeric taskId → 400", async () => {
    const { client } = makeStubClient({});
    const res = await buildApp(client).fetch(
      new Request("http://kbbl.test/safir/tasks/abc/plans"),
    );
    expect(res.status).toBe(400);
  });
});

describe("safir-proxy GET /safir/plans/:planId", () => {
  test("returns plan from safirClient.getPlan", async () => {
    const plan = makePlan({ id: "plan-xyz" });
    const { client, calls } = makeStubClient({
      getPlan: async () => plan,
    });
    const res = await buildApp(client).fetch(
      new Request("http://kbbl.test/safir/plans/plan-xyz"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(plan);
    expect(calls).toEqual([{ method: "getPlan", args: ["plan-xyz"] }]);
  });

  test("SafirHttpError(404) → 404", async () => {
    const { client } = makeStubClient({
      getPlan: async () => { throw new SafirHttpError(404, { error: "not found" }); },
    });
    const res = await buildApp(client).fetch(
      new Request("http://kbbl.test/safir/plans/no-such-plan"),
    );
    expect(res.status).toBe(404);
  });
});

describe("safir-proxy PATCH /safir/plans/:planId/status", () => {
  test("forwards body to safirClient.updatePlanStatus and returns updated plan", async () => {
    const updated = makePlan({ status: "approved" });
    const { client, calls } = makeStubClient({
      updatePlanStatus: async () => updated,
    });
    const res = await buildApp(client).fetch(
      new Request("http://kbbl.test/safir/plans/plan-1/status", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "approved" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(updated);
    expect(calls[0]?.method).toBe("updatePlanStatus");
    expect((calls[0]?.args[1] as { status: string }).status).toBe("approved");
  });

  test("invalid json body → 400", async () => {
    const { client } = makeStubClient({});
    const res = await buildApp(client).fetch(
      new Request("http://kbbl.test/safir/plans/plan-1/status", {
        method: "PATCH",
        headers: { "content-type": "text/plain" },
        body: "not json",
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("safir-proxy POST /safir/plans/:planId/reopen", () => {
  test("calls safirClient.reopenPlan and returns result", async () => {
    const reopened = makePlan({ status: "pending_approval" });
    const { client, calls } = makeStubClient({
      reopenPlan: async () => reopened,
    });
    const res = await buildApp(client).fetch(
      new Request("http://kbbl.test/safir/plans/plan-1/reopen", { method: "POST" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(reopened);
    expect(calls).toEqual([{ method: "reopenPlan", args: ["plan-1"] }]);
  });
});
