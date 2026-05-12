import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

import { SafirHttpError, type SafirClient, type CreateTaskBody } from "../../safir/client";
import type { Task } from "../../safir/types";
import {
  createProposalStore,
  type ProposalStore,
  type PlanningProposal,
} from "../../proposals/store";
import { mountPlanningProposalRoutes } from "./planning-proposals";

// === stub helpers ===

interface StubSafirOpts {
  getTask?: (taskId: number) => Promise<Task>;
  createTask?: (body: CreateTaskBody) => Promise<Task>;
  addDependency?: (taskId: number, dependsOn: number) => Promise<void>;
}

interface StubCall {
  method: string;
  args: unknown[];
}

function makeStubClient(opts: StubSafirOpts): { client: SafirClient; calls: StubCall[] } {
  const calls: StubCall[] = [];
  const notImpl = (name: string) => (..._args: unknown[]) => {
    throw new Error(`stub: ${name} not configured`);
  };
  const track =
    (name: string, impl: ((...a: unknown[]) => unknown) | undefined) =>
    async (...args: unknown[]) => {
      calls.push({ method: name, args });
      if (!impl) return notImpl(name)();
      return impl(...args);
    };

  const client: SafirClient = {
    createRun: notImpl("createRun") as SafirClient["createRun"],
    updateRun: notImpl("updateRun") as SafirClient["updateRun"],
    abandonRun: notImpl("abandonRun") as SafirClient["abandonRun"],
    createPhase: notImpl("createPhase") as SafirClient["createPhase"],
    updatePhase: notImpl("updatePhase") as SafirClient["updatePhase"],
    submitHandoff: notImpl("submitHandoff") as SafirClient["submitHandoff"],
    getTask: track("getTask", opts.getTask as ((...a: unknown[]) => unknown) | undefined) as SafirClient["getTask"],
    listTasks: notImpl("listTasks") as SafirClient["listTasks"],
    listHandoffsForTask: notImpl("listHandoffsForTask") as SafirClient["listHandoffsForTask"],
    getHandoff: notImpl("getHandoff") as SafirClient["getHandoff"],
    listPermissionProfiles: notImpl("listPermissionProfiles") as SafirClient["listPermissionProfiles"],
    getPermissionProfile: notImpl("getPermissionProfile") as SafirClient["getPermissionProfile"],
    createPermissionProfile: notImpl("createPermissionProfile") as SafirClient["createPermissionProfile"],
    updatePermissionProfile: notImpl("updatePermissionProfile") as SafirClient["updatePermissionProfile"],
    setTaskDefaultPermissionProfile: notImpl("setTaskDefaultPermissionProfile") as SafirClient["setTaskDefaultPermissionProfile"],
    createTask: track("createTask", opts.createTask as ((...a: unknown[]) => unknown) | undefined) as SafirClient["createTask"],
    addDependency: track("addDependency", opts.addDependency as ((...a: unknown[]) => unknown) | undefined) as SafirClient["addDependency"],
  };
  return { client, calls };
}

function makeTask(over: Partial<Task> = {}): Task {
  return { id: 1, project_id: "proj-1", parent_id: null, title: "stub task", status: "open", ...over };
}

function buildApp(store: ProposalStore, safirOpts: StubSafirOpts = {}): { app: Hono; calls: StubCall[] } {
  const { client, calls } = makeStubClient(safirOpts);
  const app = new Hono();
  mountPlanningProposalRoutes(app, { proposalStore: store, safirClient: client });
  return { app, calls };
}

const validPayload = {
  parent_task_id: 42,
  tasks: [{ index: 0, title: "task A", notes: "do the thing", priority: 0 }],
  dependencies: [] as { task_index: number; depends_on_index: number }[],
  summary: "all good",
  model: "claude-opus-4-7",
};

// === test setup ===

let tmpDir: string;
let store: ProposalStore;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "kbbl-proposals-test-"));
  store = await createProposalStore({ dataDir: tmpDir });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// === tests ===

describe("POST /planning-proposals", () => {
  test("1. valid one-task payload → 201 with proposal_id and status pending", async () => {
    const { app } = buildApp(store);
    const res = await app.request("/planning-proposals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validPayload),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { proposal_id: string; status: string };
    expect(typeof body.proposal_id).toBe("string");
    expect(body.proposal_id.length).toBeGreaterThan(0);
    expect(body.status).toBe("pending");
  });

  test("2. duplicate parent while one pending → 409 with existing_proposal_id", async () => {
    const { app } = buildApp(store);
    await app.request("/planning-proposals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validPayload),
    });
    const res = await app.request("/planning-proposals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validPayload),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { existing_proposal_id: string };
    expect(typeof body.existing_proposal_id).toBe("string");
  });

  test("3. missing parent_task_id → 400", async () => {
    const { app } = buildApp(store);
    const res = await app.request("/planning-proposals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...validPayload, parent_task_id: undefined }),
    });
    expect(res.status).toBe(400);
  });

  test("4. empty tasks array → 400", async () => {
    const { app } = buildApp(store);
    const res = await app.request("/planning-proposals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...validPayload, tasks: [] }),
    });
    expect(res.status).toBe(400);
  });

  test("5. task missing title → 400", async () => {
    const { app } = buildApp(store);
    const res = await app.request("/planning-proposals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...validPayload,
        tasks: [{ index: 0, notes: "no title", priority: 0 }],
      }),
    });
    expect(res.status).toBe(400);
  });

  test("6. cyclic dependencies → 400 with 'cycle' in error", async () => {
    const { app } = buildApp(store);
    const res = await app.request("/planning-proposals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...validPayload,
        tasks: [
          { index: 0, title: "A", notes: ".", priority: 0 },
          { index: 1, title: "B", notes: ".", priority: 0 },
        ],
        dependencies: [
          { task_index: 0, depends_on_index: 1 },
          { task_index: 1, depends_on_index: 0 },
        ],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error.toLowerCase()).toContain("cycle");
  });
});

describe("GET /planning-proposals", () => {
  test("7. lists only pending proposals", async () => {
    const { app } = buildApp(store);
    // Create a pending proposal
    await app.request("/planning-proposals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validPayload),
    });
    // Manually mark one as failed to verify it's excluded
    const all = store.list();
    if (all[0]) store.markFailed(all[0].id, "test failure");

    // Create a second pending proposal with different parent
    await app.request("/planning-proposals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...validPayload, parent_task_id: 99 }),
    });

    const res = await app.request("/planning-proposals");
    expect(res.status).toBe(200);
    const body = (await res.json()) as PlanningProposal[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.every((p) => p.status === "pending")).toBe(true);
  });
});

describe("GET /planning-proposals/:id", () => {
  test("8. non-existent id → 404", async () => {
    const { app } = buildApp(store);
    const res = await app.request("/planning-proposals/does-not-exist");
    expect(res.status).toBe(404);
  });

  test("9. existing proposal → 200 with full proposal body", async () => {
    const { app } = buildApp(store);
    const postRes = await app.request("/planning-proposals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validPayload),
    });
    const posted = (await postRes.json()) as { proposal_id: string };
    const res = await app.request(`/planning-proposals/${posted.proposal_id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PlanningProposal;
    expect(body.id).toBe(posted.proposal_id);
    expect(body.parent_task_id).toBe(validPayload.parent_task_id);
    expect(body.status).toBe("pending");
  });
});

describe("POST /planning-proposals/:id/approve", () => {
  test("10. successful approve: store cleared, safir calls recorded in topo order", async () => {
    let nextId = 100;
    const { app, calls } = buildApp(store, {
      getTask: async () => makeTask({ project_id: "proj-abc" }),
      createTask: async () => makeTask({ id: nextId++ }),
      addDependency: async () => {},
    });

    // 2 tasks with 1 dep: task 1 depends on task 0
    const postRes = await app.request("/planning-proposals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...validPayload,
        tasks: [
          { index: 0, title: "A", notes: ".", priority: 0 },
          { index: 1, title: "B", notes: ".", priority: 0 },
        ],
        dependencies: [{ task_index: 1, depends_on_index: 0 }],
      }),
    });
    const posted = (await postRes.json()) as { proposal_id: string };
    const id = posted.proposal_id;

    const res = await app.request(`/planning-proposals/${id}/approve`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; task_ids: number[] };
    expect(body.status).toBe("approved");
    expect(body.task_ids.length).toBe(2);

    // Proposal should be gone from store
    expect(store.get(id)).toBeNull();

    // createTask called twice, addDependency once
    const createCalls = calls.filter((c) => c.method === "createTask");
    const depCalls = calls.filter((c) => c.method === "addDependency");
    expect(createCalls.length).toBe(2);
    expect(depCalls.length).toBe(1);

    // First createTask should be for task index 0 (topo: 0 before 1)
    const firstCreate = createCalls[0]?.args[0] as CreateTaskBody;
    expect(firstCreate.title).toBe("A");
  });

  test("11. safir getTask throws SafirHttpError(404) → 404 pass-through, proposal marked failed", async () => {
    const { app } = buildApp(store, {
      getTask: async () => { throw new SafirHttpError(404, { error: "not found" }); },
    });
    const postRes = await app.request("/planning-proposals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validPayload),
    });
    const posted = (await postRes.json()) as { proposal_id: string };
    const id = posted.proposal_id;

    const res = await app.request(`/planning-proposals/${id}/approve`, { method: "POST" });
    expect(res.status).toBe(404);

    // Proposal should be in failed state
    const p = store.get(id);
    expect(p?.status).toBe("failed");
  });

  test("12. non-existent proposal → 404", async () => {
    const { app } = buildApp(store);
    const res = await app.request("/planning-proposals/no-such-id/approve", { method: "POST" });
    expect(res.status).toBe(404);
  });

  test("13. non-pending proposal (rejected) → 409 cannot approve", async () => {
    const rejectedStore: ProposalStore = {
      list: () => [],
      get: (id) => id === "fake-rejected" ? {
        id: "fake-rejected",
        parent_task_id: 1,
        tasks: [{ index: 0, title: "X", notes: ".", priority: 0 }],
        dependencies: [],
        summary: "s",
        model: "m",
        status: "rejected",
        failure_reason: null,
        created_at: new Date().toISOString(),
      } : null,
      findPendingForParent: () => null,
      create: () => { throw new Error("not used"); },
      markFailed: () => null,
      delete: () => false,
    };
    const { app: app2 } = buildApp(rejectedStore);
    const res = await app2.request("/planning-proposals/fake-rejected/approve", { method: "POST" });
    expect(res.status).toBe(409);
  });
});

describe("POST /planning-proposals/:id/reject", () => {
  test("14. reject existing → 200, store no longer has it", async () => {
    const { app } = buildApp(store);
    const postRes = await app.request("/planning-proposals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validPayload),
    });
    const posted = (await postRes.json()) as { proposal_id: string };
    const id = posted.proposal_id;

    const res = await app.request(`/planning-proposals/${id}/reject`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("rejected");
    expect(store.get(id)).toBeNull();
  });

  test("15. reject non-existent → 404", async () => {
    const { app } = buildApp(store);
    const res = await app.request("/planning-proposals/no-such-id/reject", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("Persistence", () => {
  test("16. proposal survives store reload from same directory", async () => {
    const { app } = buildApp(store);
    const postRes = await app.request("/planning-proposals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validPayload),
    });
    const posted = (await postRes.json()) as { proposal_id: string };
    const id = posted.proposal_id;

    // Poll for the persisted file with a bounded timeout (fire-and-forget write)
    let reloaded: PlanningProposal | null = null;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const store2 = await createProposalStore({ dataDir: tmpDir });
      reloaded = store2.get(id);
      if (reloaded) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(reloaded).not.toBeNull();
    expect(reloaded?.parent_task_id).toBe(validPayload.parent_task_id);
    expect(reloaded?.status).toBe("pending");
  });
});
