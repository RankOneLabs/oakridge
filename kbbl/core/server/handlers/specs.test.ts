import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { openTestDb } from "../../db/test-db";
import { insertProject } from "../../db/projects";
import { getEpicBySpec } from "../../db/epics";
import { mountProjectsRoutes } from "./projects";
import { mountSpecsRoutes } from "./specs";
import { createRuntimeRegistry, type AgentRuntime, type RuntimeRegistry } from "../../runtime";
import type { RuntimeSnapshotContrib, RuntimeConfig, SessionHandle, RuntimeEvent } from "../../runtime";
import type { EnvelopeEvent } from "../../session/session";

let db: Database;
let app: Hono;
let registry: RuntimeRegistry;

function makeRuntime(
  id: "claude-code" | "codex",
  models: readonly string[],
): AgentRuntime {
  const descriptor = {
    id,
    label: id === "claude-code" ? "Claude Code" : "Codex",
    models: models.map((model) => ({ value: model, label: model })),
    efforts:
      id === "claude-code"
        ? [{ value: "low", label: "low" }, { value: "high", label: "high" }]
        : [{ value: "minimal", label: "minimal" }, { value: "medium", label: "medium" }],
    supportsCompaction: id === "claude-code",
  };
  return {
    id,
    descriptor,
    isAllowedModel: (model: string) => models.includes(model),
    async spawn(_config: RuntimeConfig): Promise<SessionHandle> {
      return { sessionId: "sid" };
    },
    async terminate(): Promise<void> {},
    async *events(): AsyncIterable<RuntimeEvent> {},
    async send(): Promise<void> {},
    async resolveResumeRef(): Promise<{ kind: "unknown" }> {
      return { kind: "unknown" };
    },
    reconstructSnapshot(_events: readonly EnvelopeEvent[]): RuntimeSnapshotContrib {
      return {
        runtimeSid: null,
        yoloMode: false,
        allowedTools: [],
        lastResultUsage: null,
        initialObservedModel: null,
        observedModel: null,
      };
    },
  } as unknown as AgentRuntime;
}

beforeEach(() => {
  db = openTestDb();
  registry = createRuntimeRegistry([
    makeRuntime("claude-code", ["claude-opus-4-8", "claude-sonnet-4-6"]),
    makeRuntime("codex", ["gpt-5.5", "gpt-5.4-mini"]),
  ]);
  app = new Hono();
  mountProjectsRoutes(app, { db });
  mountSpecsRoutes(app, { db, registry });
});

afterEach(() => {
  db.close();
});

function post(body: unknown) {
  return app.request("/specs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /specs split model validation", () => {
  test("accepts mixed planner and worker runtimes with valid models", async () => {
    const project = insertProject(db, {
      id: "project-1",
      name: "Project",
      repo_path: "/tmp/project",
    });

    const res = await post({
      project_id: project.id,
      title: "Split spec",
      planner_model_selection: { runtime: "claude-code", model: "claude-opus-4-8" },
      worker_model_selection: { runtime: "codex", model: "gpt-5.4-mini" },
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; epic_id: string };
    const epic = getEpicBySpec(db, body.id);
    if (epic === null) throw new Error("expected created spec to have an epic");
    expect(epic.id).toBe(body.epic_id);
    expect(epic.planner_model_selection).toEqual({
      runtime: "claude-code",
      model: "claude-opus-4-8",
      effort: null,
    });
    expect(epic.worker_model_selection).toEqual({
      runtime: "codex",
      model: "gpt-5.4-mini",
      effort: null,
    });
  });

  test("persists per-role effort selections when valid for the runtime", async () => {
    const project = insertProject(db, {
      id: "project-1",
      name: "Project",
      repo_path: "/tmp/project",
    });

    const res = await post({
      project_id: project.id,
      title: "Effort spec",
      planner_model_selection: { runtime: "claude-code", model: "claude-opus-4-8", effort: "high" },
      worker_model_selection: { runtime: "codex", model: "gpt-5.4-mini", effort: "minimal" },
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    const epic = getEpicBySpec(db, body.id);
    expect(epic?.planner_model_selection.effort).toBe("high");
    expect(epic?.worker_model_selection.effort).toBe("minimal");
  });

  test("rejects an effort the selected runtime does not allow", async () => {
    const project = insertProject(db, {
      id: "project-1",
      name: "Project",
      repo_path: "/tmp/project",
    });

    // "high" is a claude-code effort but not a codex effort.
    const res = await post({
      project_id: project.id,
      title: "Bad effort spec",
      planner_model_selection: { runtime: "claude-code", model: "claude-opus-4-8" },
      worker_model_selection: { runtime: "codex", model: "gpt-5.4-mini", effort: "high" },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('worker effort "high" is not allowed for runtime "codex"');
  });

  test("rejects an invalid runtime id with a clear error", async () => {
    insertProject(db, {
      id: "project-1",
      name: "Project",
      repo_path: "/tmp/project",
    });

    const res = await post({
      project_id: "project-1",
      title: "Split spec",
      planner_model_selection: { runtime: "not-registered", model: "claude-opus-4-8" },
      worker_model_selection: { runtime: "codex", model: "gpt-5.4-mini" },
    });

    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toEqual({
      error: 'planner runtime "not-registered" is not registered — registered: claude-code, codex',
    });
  });

  test("rejects planner models that are not listed for the selected runtime", async () => {
    insertProject(db, {
      id: "project-1",
      name: "Project",
      repo_path: "/tmp/project",
    });

    const res = await post({
      project_id: "project-1",
      title: "Split spec",
      planner_model_selection: { runtime: "claude-code", model: "gpt-5.4-mini" },
      worker_model_selection: { runtime: "codex", model: "gpt-5.4-mini" },
    });

    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toEqual({
      error: 'planner model "gpt-5.4-mini" is not allowed for runtime "claude-code"',
    });
  });

  test("rejects worker models that are not listed for the selected runtime", async () => {
    insertProject(db, {
      id: "project-1",
      name: "Project",
      repo_path: "/tmp/project",
    });

    const res = await post({
      project_id: "project-1",
      title: "Split spec",
      planner_model_selection: { runtime: "claude-code", model: "claude-opus-4-8" },
      worker_model_selection: { runtime: "codex", model: "claude-opus-4-8" },
    });

    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toEqual({
      error: 'worker model "claude-opus-4-8" is not allowed for runtime "codex"',
    });
  });
});
