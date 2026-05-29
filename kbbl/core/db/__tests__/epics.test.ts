import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openTestDb } from "../test-db";
import { insertProject } from "../projects";
import { insertSpec } from "../specs";
import { insertEpic, getEpic, getEpicBySpec, listEpicsByProject, updateEpicFields, updateEpicRouting } from "../epics";

const PROJECT_ID = "proj-1";
const SPEC_ID = "spec-1";

let db: Database;

beforeEach(() => {
  db = openTestDb();
  insertProject(db, { id: PROJECT_ID, name: "P", repo_path: "/p" });
  insertSpec(db, { id: SPEC_ID, project_id: PROJECT_ID, title: "S" });
});

afterEach(() => {
  db.close();
});

describe("insertEpic + getEpic", () => {
  test("round-trips all fields", () => {
    const e = insertEpic(db, {
      id: "e1",
      spec_id: SPEC_ID,
      project_id: PROJECT_ID,
      title: "My Epic",
      status: "active",
      current_stage: "spec",
    });
    expect(e.id).toBe("e1");
    expect(e.spec_id).toBe(SPEC_ID);
    expect(e.project_id).toBe(PROJECT_ID);
    expect(e.title).toBe("My Epic");
    expect(e.status).toBe("active");
    expect(e.current_stage).toBe("spec");
    expect(e.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("getEpic returns null for unknown id", () => {
    expect(getEpic(db, "nope")).toBeNull();
  });

  test("getEpic returns inserted row", () => {
    insertEpic(db, { id: "e2", spec_id: SPEC_ID, project_id: PROJECT_ID, title: "E", status: "active", current_stage: "spec" });
    const found = getEpic(db, "e2");
    expect(found).not.toBeNull();
    expect(found?.spec_id).toBe(SPEC_ID);
  });

  test("enforces UNIQUE(spec_id) — second insert on same spec throws", () => {
    insertEpic(db, { id: "e3", spec_id: SPEC_ID, project_id: PROJECT_ID, title: "E", status: "active", current_stage: "spec" });
    expect(() =>
      insertEpic(db, { id: "e4", spec_id: SPEC_ID, project_id: PROJECT_ID, title: "E2", status: "active", current_stage: "spec" }),
    ).toThrow();
  });
});

describe("getEpicBySpec", () => {
  test("returns null when no epic exists for spec", () => {
    expect(getEpicBySpec(db, SPEC_ID)).toBeNull();
  });

  test("returns the epic for the spec", () => {
    insertEpic(db, { id: "e5", spec_id: SPEC_ID, project_id: PROJECT_ID, title: "E", status: "active", current_stage: "spec" });
    const found = getEpicBySpec(db, SPEC_ID);
    expect(found?.id).toBe("e5");
  });
});

describe("listEpicsByProject", () => {
  test("returns empty array when none exist", () => {
    expect(listEpicsByProject(db, PROJECT_ID)).toEqual([]);
  });

  test("returns all epics for project", () => {
    insertSpec(db, { id: "spec-2", project_id: PROJECT_ID, title: "S2" });
    insertEpic(db, { id: "ea", spec_id: SPEC_ID, project_id: PROJECT_ID, title: "A", status: "active", current_stage: "spec" });
    insertEpic(db, { id: "eb", spec_id: "spec-2", project_id: PROJECT_ID, title: "B", status: "complete", current_stage: "assess" });

    const all = listEpicsByProject(db, PROJECT_ID);
    expect(all).toHaveLength(2);
  });

  test("filters by status when provided", () => {
    insertSpec(db, { id: "spec-3", project_id: PROJECT_ID, title: "S3" });
    insertEpic(db, { id: "ec", spec_id: SPEC_ID, project_id: PROJECT_ID, title: "C", status: "active", current_stage: "spec" });
    insertEpic(db, { id: "ed", spec_id: "spec-3", project_id: PROJECT_ID, title: "D", status: "complete", current_stage: "assess" });

    const active = listEpicsByProject(db, PROJECT_ID, "active");
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe("ec");
  });

  test("does not return epics from another project", () => {
    insertProject(db, { id: "proj-2", name: "Q", repo_path: "/q" });
    insertSpec(db, { id: "spec-4", project_id: "proj-2", title: "S4" });
    insertEpic(db, { id: "ee", spec_id: SPEC_ID, project_id: PROJECT_ID, title: "E", status: "active", current_stage: "spec" });
    insertEpic(db, { id: "ef", spec_id: "spec-4", project_id: "proj-2", title: "F", status: "active", current_stage: "spec" });

    expect(listEpicsByProject(db, PROJECT_ID)).toHaveLength(1);
    expect(listEpicsByProject(db, "proj-2")).toHaveLength(1);
  });
});

describe("updateEpicFields", () => {
  test("updates status", () => {
    insertEpic(db, { id: "eu", spec_id: SPEC_ID, project_id: PROJECT_ID, title: "U", status: "active", current_stage: "spec" });
    const updated = updateEpicFields(db, "eu", { status: "complete" });
    expect(updated?.status).toBe("complete");
  });

  test("updates current_stage", () => {
    insertEpic(db, { id: "ev", spec_id: SPEC_ID, project_id: PROJECT_ID, title: "V", status: "active", current_stage: "spec" });
    const updated = updateEpicFields(db, "ev", { current_stage: "build" });
    expect(updated?.current_stage).toBe("build");
  });

  test("returns null for unknown id", () => {
    expect(updateEpicFields(db, "nope", { status: "complete" })).toBeNull();
  });

  test("no-op update returns current row", () => {
    insertEpic(db, { id: "ew", spec_id: SPEC_ID, project_id: PROJECT_ID, title: "W", status: "active", current_stage: "spec" });
    const result = updateEpicFields(db, "ew", {});
    expect(result?.id).toBe("ew");
    expect(result?.status).toBe("active");
  });
});

describe("migration 021 — routing columns", () => {
  test("four columns exist on epics table", () => {
    const cols = db.prepare("PRAGMA table_info(epics)").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("planner_runtime");
    expect(names).toContain("planner_model");
    expect(names).toContain("build_runtime");
    expect(names).toContain("build_model");
  });

  test("routing columns are NULL for a row inserted without specifying them", () => {
    insertEpic(db, { id: "em1", spec_id: SPEC_ID, project_id: PROJECT_ID, title: "M", status: "pending", current_stage: "spec" });
    const row = db
      .prepare("SELECT planner_runtime, planner_model, build_runtime, build_model FROM epics WHERE id = ?")
      .get("em1") as Record<string, unknown>;
    expect(row.planner_runtime).toBeNull();
    expect(row.planner_model).toBeNull();
    expect(row.build_runtime).toBeNull();
    expect(row.build_model).toBeNull();
  });
});

describe("insertEpic routing fields", () => {
  test("round-trips routing fields when provided", () => {
    insertSpec(db, { id: "spec-r1", project_id: PROJECT_ID, title: "R1" });
    const e = insertEpic(db, {
      id: "er1",
      spec_id: "spec-r1",
      project_id: PROJECT_ID,
      title: "R",
      status: "pending",
      current_stage: "spec",
      planner_runtime: "claude-code",
      planner_model: "claude-opus-4-7",
      build_runtime: "codex",
      build_model: "codex-4",
    });
    expect(e.planner_runtime).toBe("claude-code");
    expect(e.planner_model).toBe("claude-opus-4-7");
    expect(e.build_runtime).toBe("codex");
    expect(e.build_model).toBe("codex-4");
  });

  test("routing fields default to null when omitted", () => {
    const e = insertEpic(db, {
      id: "er2",
      spec_id: SPEC_ID,
      project_id: PROJECT_ID,
      title: "R2",
      status: "pending",
      current_stage: "spec",
    });
    expect(e.planner_runtime).toBeNull();
    expect(e.planner_model).toBeNull();
    expect(e.build_runtime).toBeNull();
    expect(e.build_model).toBeNull();
  });
});

describe("updateEpicRouting", () => {
  test("updates only specified routing fields", () => {
    insertEpic(db, { id: "er3", spec_id: SPEC_ID, project_id: PROJECT_ID, title: "R3", status: "pending", current_stage: "spec" });
    const updated = updateEpicRouting(db, "er3", { planner_runtime: "claude-code", planner_model: "claude-opus-4-7" });
    expect(updated?.planner_runtime).toBe("claude-code");
    expect(updated?.planner_model).toBe("claude-opus-4-7");
    expect(updated?.build_runtime).toBeNull();
    expect(updated?.build_model).toBeNull();
  });

  test("can set a routing field to null (clear it)", () => {
    insertSpec(db, { id: "spec-r4", project_id: PROJECT_ID, title: "R4" });
    insertEpic(db, {
      id: "er4",
      spec_id: "spec-r4",
      project_id: PROJECT_ID,
      title: "R4",
      status: "pending",
      current_stage: "spec",
      planner_runtime: "codex",
    });
    const updated = updateEpicRouting(db, "er4", { planner_runtime: null });
    expect(updated?.planner_runtime).toBeNull();
  });

  test("returns null for unknown id", () => {
    expect(updateEpicRouting(db, "nope", { planner_runtime: "codex" })).toBeNull();
  });

  test("empty fields object returns current row without updating", () => {
    insertEpic(db, { id: "er5", spec_id: SPEC_ID, project_id: PROJECT_ID, title: "R5", status: "pending", current_stage: "spec" });
    const result = updateEpicRouting(db, "er5", {});
    expect(result?.id).toBe("er5");
  });
});
