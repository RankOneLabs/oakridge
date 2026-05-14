import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Hono } from "hono";

import { SafirHttpError, type SafirClient } from "../../safir/client";
import { mountBuildsRoutes } from "./builds";

function notImpl(name: string): never {
  throw new Error(`stub: ${name} not configured for this test`);
}

function makeClient(overrides: Partial<SafirClient>): SafirClient {
  const stub: SafirClient = {
    createRun: () => notImpl("createRun"),
    updateRun: () => notImpl("updateRun"),
    abandonRun: () => notImpl("abandonRun"),
    createPhase: () => notImpl("createPhase"),
    updatePhase: () => notImpl("updatePhase"),
    submitHandoff: () => notImpl("submitHandoff"),
    listTasks: () => notImpl("listTasks"),
    getTask: () => notImpl("getTask"),
    listHandoffsForTask: () => notImpl("listHandoffsForTask"),
    getHandoff: () => notImpl("getHandoff"),
    listPermissionProfiles: () => notImpl("listPermissionProfiles"),
    getPermissionProfile: () => notImpl("getPermissionProfile"),
    createPermissionProfile: () => notImpl("createPermissionProfile"),
    updatePermissionProfile: () => notImpl("updatePermissionProfile"),
    setTaskDefaultPermissionProfile: () => notImpl("setTaskDefaultPermissionProfile"),
    createTask: () => notImpl("createTask"),
    addDependency: () => notImpl("addDependency"),
    listPlansForTask: () => notImpl("listPlansForTask"),
    listPlans: () => notImpl("listPlans"),
    listTaskDependencies: () => notImpl("listTaskDependencies"),
    getPlan: () => notImpl("getPlan"),
    updatePlanStatus: () => notImpl("updatePlanStatus"),
    reopenPlan: () => notImpl("reopenPlan"),
    getThread: () => notImpl("getThread"),
    getAtomMap: () => notImpl("getAtomMap"),
    listOpenThreads: () => notImpl("listOpenThreads"),
    postAgentResponse: () => notImpl("postAgentResponse"),
    listAllThreads: () => notImpl("listAllThreads"),
    listAtomHistory: () => notImpl("listAtomHistory"),
    postAtomEdit: () => notImpl("postAtomEdit"),
    createThread: () => notImpl("createThread"),
    postThreadMessage: () => notImpl("postThreadMessage"),
    pingThread: () => notImpl("pingThread"),
    updateThreadStatus: () => notImpl("updateThreadStatus"),
    listBuildBriefs: () => notImpl("listBuildBriefs"),
    getBuildBrief: () => notImpl("getBuildBrief"),
    getBuildBriefRun: () => notImpl("getBuildBriefRun"),
    updateBuildBriefStatus: () => notImpl("updateBuildBriefStatus"),
    reopenBuildBrief: () => notImpl("reopenBuildBrief"),
    createRunFromBuildBrief: () => notImpl("createRunFromBuildBrief"),
    getProjectRepoPath: () => notImpl("getProjectRepoPath"),
  } as unknown as SafirClient;
  return { ...stub, ...overrides };
}

function buildApp(client: SafirClient): Hono {
  const app = new Hono();
  mountBuildsRoutes(app, { safirClient: client });
  return app;
}

let tmpRepo: string;

beforeEach(() => {
  // Create a real git repo so worktree creation can succeed in test 2.
  tmpRepo = mkdtempSync(`${tmpdir()}/builds-test-`);
  execSync("git init && git checkout -b main && git commit --allow-empty -m init", {
    cwd: tmpRepo,
    stdio: "ignore",
  });
});

afterEach(() => {
  rmSync(tmpRepo, { recursive: true, force: true });
});

describe("POST /safir-proxy/build-briefs/:id/build", () => {
  test("first build: 409 already_started when phase_index=1 already exists", async () => {
    const client = makeClient({
      getBuildBrief: async () => ({ id: "brief-1", status: "approved", task_id: null }),
      getBuildBriefRun: async () => ({
        id: "run-1",
        task_id: null,
        phases: [{ phase_index: 1, id: "ph-1" }],
      }),
    } as unknown as Partial<SafirClient>);
    const app = buildApp(client);

    const res = await app.fetch(
      new Request("http://kbbl.test/safir-proxy/build-briefs/brief-1/build", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("already_started");
  });

  test("retry build: bypasses phase check and succeeds (202) against a real git repo", async () => {
    const client = makeClient({
      getBuildBrief: async () => ({ id: "brief-r", status: "approved", task_id: 7 }),
      createRunFromBuildBrief: async () => ({ id: "new-run-id" }),
      getTask: async () => ({ id: 7, project_id: "p1", title: "t", notes: null, status: "open", parent_id: null }),
      getProjectRepoPath: async () => ({ repo_path: tmpRepo }),
    } as unknown as Partial<SafirClient>);
    const app = buildApp(client);

    const res = await app.fetch(
      new Request("http://kbbl.test/safir-proxy/build-briefs/brief-r/build", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ retry: true }),
      }),
    );

    // 202 means the subprocess was spawned (even if safir-build isn't in PATH,
    // the handler has already returned by then).
    expect(res.status).toBe(202);
    const body = (await res.json()) as { status: string; run_id: string };
    expect(body.status).toBe("build_started");
    expect(body.run_id).toBe("new-run-id");
  });

  test("retry against non-approved brief: 409 from safir propagated", async () => {
    const client = makeClient({
      getBuildBrief: async () => {
        throw new SafirHttpError(409, { error: "build_brief_not_approved", status: "pending_approval" });
      },
    } as unknown as Partial<SafirClient>);
    const app = buildApp(client);

    const res = await app.fetch(
      new Request("http://kbbl.test/safir-proxy/build-briefs/brief-na/build", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ retry: true }),
      }),
    );

    expect(res.status).toBe(409);
  });
});
