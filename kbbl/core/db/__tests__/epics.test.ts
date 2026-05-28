import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openTestDb } from "../test-db";
import { insertProject } from "../projects";
import { insertSpec } from "../specs";
import { insertEpic, getEpic, getEpicBySpec, listEpicsByProject, updateEpicFields } from "../epics";

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
