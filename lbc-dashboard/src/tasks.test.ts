import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "../server";
import { RunRegistry, type Launcher } from "./runs";

function makeStub(exitCode: number): Launcher {
  const done = Promise.resolve({
    code: exitCode,
    stderrTail: exitCode === 0 ? "" : "subprocess failed",
  });
  return {
    spawn(_args, _opts) {
      return { pid: 12345, kill: () => {}, done };
    },
  };
}

const LOCAL_TASK = {
  name: "dashboard_local_note",
  artifact_type: "prose" as const,
  artifact_filename: "draft.md",
  seed_content: "# seed",
  brief: {
    target_spec: "write a short dashboard note",
    success_criteria: ["covers the main point"],
    constraints: ["keep it concise"],
  },
  grader: { kind: "none" as const },
};

describe("HTTP /api/tasks and /api/graders", () => {
  let dashboardDataRoot: string;
  let runRoot: string;
  let originalDashboardDataRoot: string | undefined;
  let originalRunRoot: string | undefined;

  beforeEach(async () => {
    dashboardDataRoot = await mkdtemp(
      join(tmpdir(), "lbc-dashboard-data-test-"),
    );
    runRoot = await mkdtemp(join(tmpdir(), "lbc-run-test-"));
    originalDashboardDataRoot = process.env.LBC_DASHBOARD_DATA_ROOT;
    originalRunRoot = process.env.LBC_RUN_ROOT;
    process.env.LBC_DASHBOARD_DATA_ROOT = dashboardDataRoot;
    process.env.LBC_RUN_ROOT = runRoot;
  });

  afterEach(async () => {
    if (originalDashboardDataRoot === undefined) {
      delete process.env.LBC_DASHBOARD_DATA_ROOT;
    } else {
      process.env.LBC_DASHBOARD_DATA_ROOT = originalDashboardDataRoot;
    }
    if (originalRunRoot === undefined) {
      delete process.env.LBC_RUN_ROOT;
    } else {
      process.env.LBC_RUN_ROOT = originalRunRoot;
    }
    await rm(dashboardDataRoot, { recursive: true, force: true });
    await rm(runRoot, { recursive: true, force: true });
  });

  test("GET /api/tasks merges built-ins with local tasks", async () => {
    const registry = new RunRegistry(makeStub(0));
    const app = createApp({ registry });

    const createRes = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(LOCAL_TASK),
    });
    expect(createRes.status).toBe(200);

    const listRes = await app.request("/api/tasks");
    expect(listRes.status).toBe(200);
    const json = (await listRes.json()) as {
      tasks: Array<{ name: string; source: string }>;
    };

    expect(
      json.tasks.some(
        (task) =>
          task.name === "prose_substrate_thesis" && task.source === "builtin",
      ),
    ).toBe(true);
    expect(
      json.tasks.some(
        (task) =>
          task.name === "dashboard_local_note" && task.source === "local",
      ),
    ).toBe(true);
  });

  test("POST /api/runs rejects grade=true for a local task without a grader", async () => {
    const registry = new RunRegistry(makeStub(0));
    const app = createApp({ registry });

    const createRes = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(LOCAL_TASK),
    });
    expect(createRes.status).toBe(200);

    const runRes = await app.request("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: LOCAL_TASK.name,
        model_pool: ["claude-opus-4-7"],
        condition: { kind: "single_agent", n: 1 },
        grade: true,
      }),
    });

    expect(runRes.status).toBe(400);
    const json = (await runRes.json()) as { error: string };
    expect(json.error).toBe("task has no grader");
  });

  test("POST /api/runs writes a task-based run spec for local ungraded launches", async () => {
    const registry = new RunRegistry(makeStub(0));
    const app = createApp({ registry });

    const createRes = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(LOCAL_TASK),
    });
    expect(createRes.status).toBe(200);

    const runRes = await app.request("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: LOCAL_TASK.name,
        model_pool: ["claude-opus-4-7"],
        condition: { kind: "single_agent", n: 1 },
        grade: false,
      }),
    });

    expect(runRes.status).toBe(200);
    const json = (await runRes.json()) as { run_ts: string };
    const spec = JSON.parse(
      await readFile(
        join(runRoot, json.run_ts, "run-spec.json"),
        "utf-8",
      ),
    ) as {
      task: string;
      grade: boolean;
      local_task_dir?: string;
      target?: string;
    };

    expect(spec.task).toBe(LOCAL_TASK.name);
    expect(spec.grade).toBe(false);
    expect(spec.local_task_dir).toBe(join(dashboardDataRoot, "tasks"));
    expect(spec.target).toBeUndefined();
  });
});
