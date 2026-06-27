import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTestDb } from "./test-db";
import { insertSpec, getSpec, listSpecsByProject, updateSpecFields } from "./specs";
import { mountSpecsRoutes } from "../server/handlers/specs";
import { taskTrackerEvents } from "./events";
import { insertProject } from "./projects";
import { insertEpic, getEpicBySpec } from "./epics";
import type { AgentRuntime, RuntimeId, RuntimeRegistry } from "../runtime";

let db: Database;
let app: Hono;
let repoPath: string;

const PROJECT_ID = "proj-1";

const MODELS_BY_RUNTIME: Record<RuntimeId, string[]> = {
  "claude-code": ["claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5-20251001", "opus", "sonnet", "haiku"],
  codex: ["gpt-5.5", "gpt-5.4-mini"],
};

function makeRegistry(runtimeIds: RuntimeId[]): RuntimeRegistry {
  return {
    defaultId: runtimeIds[0] ?? "claude-code",
    runtimes: new Map(
      runtimeIds.map((id) => [
        id,
        {
          id,
          descriptor: {
            id,
            label: id,
            models: MODELS_BY_RUNTIME[id].map((value) => ({ value, label: value })),
            supportsCompaction: id === "claude-code",
          },
          isAllowedModel: (model: string) => MODELS_BY_RUNTIME[id].includes(model),
        } as unknown as AgentRuntime,
      ]),
    ),
  };
}

beforeEach(() => {
  db = openTestDb();
  repoPath = mkdtempSync(join(tmpdir(), "specs-repo-"));
  insertProject(db, { id: PROJECT_ID, name: "Test Project", repo_path: repoPath });
  app = new Hono();
  mountSpecsRoutes(app, { db, registry: makeRegistry(["claude-code", "codex"]) });
});

afterEach(() => {
  db.close();
  rmSync(repoPath, { recursive: true, force: true });
});

describe("specs query helpers", () => {
  test("insertSpec returns the row with generated created_at", () => {
    const spec = insertSpec(db, { id: "s1", project_id: PROJECT_ID, title: "Do the thing" });
    expect(spec.id).toBe("s1");
    expect(spec.project_id).toBe(PROJECT_ID);
    expect(spec.title).toBe("Do the thing");
    expect(spec.notes).toBeNull();
    // specs.status dropped in migration 016; internal_status is the lifecycle field now
    expect(spec.internal_status).toBe("analyzing");
    expect(spec.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("insertSpec stores notes", () => {
    const spec = insertSpec(db, { id: "s2", project_id: PROJECT_ID, title: "T", notes: "some notes" });
    expect(spec.notes).toBe("some notes");
  });

  test("getSpec returns null for unknown id", () => {
    expect(getSpec(db, "no-such")).toBeNull();
  });

  test("getSpec returns the row after insert", () => {
    insertSpec(db, { id: "s3", project_id: PROJECT_ID, title: "T" });
    expect(getSpec(db, "s3")?.title).toBe("T");
  });

  test("listSpecsByProject includes specs with non-archived epics", () => {
    insertSpec(db, { id: "sa", project_id: PROJECT_ID, title: "A" });
    insertEpic(db, {
      id: "ea",
      spec_id: "sa",
      project_id: PROJECT_ID,
      title: "Epic A",
      status: "active",
      current_stage: "spec",
    });

    const specs = listSpecsByProject(db, PROJECT_ID);
    expect(specs).toHaveLength(1);
    expect(specs[0]?.id).toBe("sa");
    expect(specs[0]?.epic_id).toBe("ea");
  });

  test("listSpecsByProject omits specs whose epic is archived", () => {
    insertSpec(db, { id: "sa", project_id: PROJECT_ID, title: "A" });
    insertEpic(db, {
      id: "ea",
      spec_id: "sa",
      project_id: PROJECT_ID,
      title: "Epic A",
      status: "archived",
      current_stage: "spec",
    });

    expect(listSpecsByProject(db, PROJECT_ID)).toEqual([]);
  });

  test("listSpecsByProject keeps specs without an epic visible", () => {
    insertSpec(db, { id: "sa", project_id: PROJECT_ID, title: "A" });

    const specs = listSpecsByProject(db, PROJECT_ID);
    expect(specs).toHaveLength(1);
    expect(specs[0]?.id).toBe("sa");
    expect(specs[0]?.epic_id).toBeNull();
  });

  test("listSpecsByProject still scopes results by project", () => {
    insertProject(db, { id: "proj-2", name: "P2", repo_path: "/p2" });
    insertSpec(db, { id: "sa", project_id: PROJECT_ID, title: "A" });
    insertEpic(db, {
      id: "ea",
      spec_id: "sa",
      project_id: PROJECT_ID,
      title: "Epic A",
      status: "active",
      current_stage: "spec",
    });
    insertSpec(db, { id: "sb", project_id: "proj-2", title: "B" });
    insertEpic(db, {
      id: "eb",
      spec_id: "sb",
      project_id: "proj-2",
      title: "Epic B",
      status: "active",
      current_stage: "spec",
    });

    const specs = listSpecsByProject(db, PROJECT_ID);
    expect(specs).toHaveLength(1);
    expect(specs[0]?.id).toBe("sa");
  });

  test("updateSpecFields updates title", () => {
    insertSpec(db, { id: "s4", project_id: PROJECT_ID, title: "Old" });
    const updated = updateSpecFields(db, "s4", { title: "New" });
    expect(updated?.title).toBe("New");
  });

  test("updateSpecFields updates notes to null", () => {
    insertSpec(db, { id: "s5", project_id: PROJECT_ID, title: "T", notes: "hi" });
    const updated = updateSpecFields(db, "s5", { notes: null });
    expect(updated?.notes).toBeNull();
  });

  test("updateSpecFields returns null for unknown id", () => {
    expect(updateSpecFields(db, "nope", { title: "X" })).toBeNull();
  });

  test("insertSpec rejects unknown project_id (FK)", () => {
    expect(() =>
      insertSpec(db, { id: "s6", project_id: "no-project", title: "T" }),
    ).toThrow();
  });
});

describe("GET /specs", () => {
  test("returns 400 without project_id param", async () => {
    const res = await app.request("/specs");
    expect(res.status).toBe(400);
  });

  test("returns empty array for project with no specs", async () => {
    const res = await app.request(`/specs?project_id=${PROJECT_ID}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("returns specs for the given project", async () => {
    insertSpec(db, { id: "s1", project_id: PROJECT_ID, title: "T" });
    const res = await app.request(`/specs?project_id=${PROJECT_ID}`);
    const body = (await res.json()) as { id: string }[];
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe("s1");
  });
});

describe("POST /specs", () => {
  test("creates a spec and returns 201", async () => {
    const res = await app.request("/specs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: PROJECT_ID, title: "New spec" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; internal_status: string };
    expect(typeof body.id).toBe("string");
    // specs.status dropped in migration 016; internal_status starts as 'analyzing'
    expect(body.internal_status).toBe("analyzing");
  });

  test("emits spec.created event after insert", async () => {
    let emittedId: string | null = null;
    const unsub = taskTrackerEvents.subscribe("spec.created", ({ spec_id }) => {
      emittedId = spec_id;
    });
    try {
      const res = await app.request("/specs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project_id: PROJECT_ID, title: "Emit test" }),
      });
      const body = (await res.json()) as { id: string };
      expect(emittedId).not.toBeNull();
      expect(emittedId!).toBe(body.id);
    } finally {
      unsub();
    }
  });

  test("stores selected agent runtime on the created epic and backfills split selections", async () => {
    const res = await app.request("/specs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project_id: PROJECT_ID,
        title: "Codex flow",
        agent_runtime: "codex",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    const epic = getEpicBySpec(db, body.id);
    expect(epic?.agent_runtime).toBe("codex");
    expect(epic?.planner_model_selection).toEqual({
      runtime: "codex",
      model: "gpt-5.5",
    });
    expect(epic?.worker_model_selection).toEqual({
      runtime: "codex",
      model: "gpt-5.4-mini",
    });
  });

  test("accepts explicit planner and worker model selections", async () => {
    const res = await app.request("/specs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project_id: PROJECT_ID,
        title: "Split flow",
        planner_model_selection: { runtime: "claude-code", model: "claude-opus-4-8" },
        worker_model_selection: { runtime: "codex", model: "gpt-5.4-mini" },
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    const epic = getEpicBySpec(db, body.id);
    expect(epic?.agent_runtime).toBe("claude-code");
    expect(epic?.planner_model_selection).toEqual({
      runtime: "claude-code",
      model: "claude-opus-4-8",
    });
    expect(epic?.worker_model_selection).toEqual({
      runtime: "codex",
      model: "gpt-5.4-mini",
    });
  });

  test("rejects a model that the selected runtime does not allow", async () => {
    const res = await app.request("/specs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project_id: PROJECT_ID,
        title: "Bad split",
        planner_model_selection: { runtime: "codex", model: "not-a-model" },
        worker_model_selection: { runtime: "codex", model: "gpt-5.4-mini" },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("not allowed");
  });

  test("falls back to claude-code when no runtime registry is mounted", async () => {
    const noRegistryApp = new Hono();
    mountSpecsRoutes(noRegistryApp, { db });

    const res = await noRegistryApp.request("/specs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project_id: PROJECT_ID,
        title: "Fallback flow",
        planner_model_selection: { runtime: "claude-code", model: "custom-planner-model" },
        worker_model_selection: { runtime: "claude-code", model: "custom-worker-model" },
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    const epic = getEpicBySpec(db, body.id);
    expect(epic?.agent_runtime).toBe("claude-code");
    expect(epic?.planner_model_selection).toEqual({
      runtime: "claude-code",
      model: "custom-planner-model",
    });
    expect(epic?.worker_model_selection).toEqual({
      runtime: "claude-code",
      model: "custom-worker-model",
    });
  });

  test("rejects unregistered agent runtime before inserting the spec", async () => {
    const claudeOnlyApp = new Hono();
    mountSpecsRoutes(claudeOnlyApp, { db, registry: makeRegistry(["claude-code"]) });

    const res = await claudeOnlyApp.request("/specs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project_id: PROJECT_ID,
        title: "Codex flow",
        agent_runtime: "codex",
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('runtime "codex" is not registered');
    expect(listSpecsByProject(db, PROJECT_ID)).toHaveLength(0);
  });

  test("returns 400 for missing title", async () => {
    const res = await app.request("/specs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: PROJECT_ID }),
    });
    expect(res.status).toBe(400);
  });

  test("returns 404 for unknown project_id", async () => {
    const res = await app.request("/specs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: "no-project", title: "T" }),
    });
    expect(res.status).toBe(404);
  });

  test("returns 400 for invalid json", async () => {
    const res = await app.request("/specs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  test("reads notes from notesPath inside the project's repo_path", async () => {
    const path = join(repoPath, "spec.md");
    writeFileSync(path, "# Spec prose\n\nFrom file.");
    const res = await app.request("/specs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: PROJECT_ID, title: "From path", notesPath: path }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; notes: string | null };
    expect(body.notes).toBe("# Spec prose\n\nFrom file.");
  });

  test("reads notes from a repo-root-relative notesPath", async () => {
    writeFileSync(join(repoPath, "spec.md"), "from relative path");
    const res = await app.request("/specs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: PROJECT_ID, title: "From relative", notesPath: "spec.md" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { notes: string | null };
    expect(body.notes).toBe("from relative path");
  });

  test("returns 400 when notesPath file does not exist", async () => {
    const missing = join(repoPath, "does-not-exist.md");
    const res = await app.request("/specs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: PROJECT_ID, title: "Missing", notesPath: missing }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("notesPath not found");
  });

  test("returns 400 when notesPath resolves outside repo_path", async () => {
    const outside = mkdtempSync(join(tmpdir(), "specs-outside-"));
    try {
      const path = join(outside, "evil.md");
      writeFileSync(path, "secret");
      const res = await app.request("/specs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project_id: PROJECT_ID, title: "Outside", notesPath: path }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("repo_path");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("returns 400 when notesPath is a symlink pointing outside repo_path", async () => {
    const outside = mkdtempSync(join(tmpdir(), "specs-symlink-target-"));
    try {
      const target = join(outside, "evil.md");
      writeFileSync(target, "secret");
      const link = join(repoPath, "link.md");
      symlinkSync(target, link);
      const res = await app.request("/specs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project_id: PROJECT_ID, title: "Symlink escape", notesPath: link }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("repo_path");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("returns 400 when both notes and notesPath are provided", async () => {
    const res = await app.request("/specs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project_id: PROJECT_ID,
        title: "Both",
        notes: "inline",
        notesPath: join(repoPath, "whatever.md"),
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("either notes or notesPath");
  });
});

describe("GET /specs/:id", () => {
  test("returns 404 for unknown id", async () => {
    const res = await app.request("/specs/no-such-id");
    expect(res.status).toBe(404);
  });

  test("returns the spec by id", async () => {
    insertSpec(db, { id: "known", project_id: PROJECT_ID, title: "Known spec" });
    const res = await app.request("/specs/known");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; title: string };
    expect(body.id).toBe("known");
    expect(body.title).toBe("Known spec");
  });
});

describe("PATCH /specs/:id", () => {
  test("updates title and returns updated spec", async () => {
    insertSpec(db, { id: "p1", project_id: PROJECT_ID, title: "Old" });
    const res = await app.request("/specs/p1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "New" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { title: string };
    expect(body.title).toBe("New");
  });

  test("returns 400 if body contains no mutable fields", async () => {
    insertSpec(db, { id: "p2", project_id: PROJECT_ID, title: "T" });
    const res = await app.request("/specs/p2", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    // specs.status was dropped; 'status' is not in PatchSpecSchema so it's filtered out,
    // leaving an empty update that returns 400 "at least one mutable field is required"
    expect(res.status).toBe(400);
  });

  test("returns 404 for unknown id", async () => {
    const res = await app.request("/specs/nope", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "X" }),
    });
    expect(res.status).toBe(404);
  });
});
