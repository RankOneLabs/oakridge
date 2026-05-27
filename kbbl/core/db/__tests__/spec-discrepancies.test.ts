import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openTestDb } from "../test-db";
import { insertProject } from "../projects";
import { insertSpec } from "../specs";
import {
  insertSpecDiscrepancy,
  getSpecDiscrepancy,
  listSpecDiscrepancies,
  countOpenDiscrepancies,
  updateSpecDiscrepancy,
} from "../spec-discrepancies";

const PROJECT_ID = "proj-1";
const SPEC_ID = "spec-1";

const MINIMAL = {
  spec_id: SPEC_ID,
  spec_assumption: "Auth returns 200 on success",
  code_reality: "Auth returns 204 on success",
  status: "open" as const,
};

let db: Database;

beforeEach(() => {
  db = openTestDb();
  insertProject(db, { id: PROJECT_ID, name: "P", repo_path: "/p" });
  insertSpec(db, { id: SPEC_ID, project_id: PROJECT_ID, title: "S" });
});

afterEach(() => {
  db.close();
});

describe("insertSpecDiscrepancy + getSpecDiscrepancy", () => {
  test("round-trips all fields", () => {
    const d = insertSpecDiscrepancy(db, { id: "d1", ...MINIMAL });
    expect(d.id).toBe("d1");
    expect(d.spec_id).toBe(SPEC_ID);
    expect(d.spec_assumption).toBe("Auth returns 200 on success");
    expect(d.code_reality).toBe("Auth returns 204 on success");
    expect(d.resolution).toBeNull();
    expect(d.status).toBe("open");
    expect(d.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("stores non-null resolution", () => {
    const d = insertSpecDiscrepancy(db, { id: "d2", ...MINIMAL, resolution: "Accepted 204 as correct", status: "resolved" });
    expect(d.resolution).toBe("Accepted 204 as correct");
    expect(d.status).toBe("resolved");
  });

  test("getSpecDiscrepancy returns null for unknown id", () => {
    expect(getSpecDiscrepancy(db, "nope")).toBeNull();
  });

  test("getSpecDiscrepancy returns inserted row", () => {
    insertSpecDiscrepancy(db, { id: "d3", ...MINIMAL });
    const found = getSpecDiscrepancy(db, "d3");
    expect(found).not.toBeNull();
    expect(found?.spec_id).toBe(SPEC_ID);
  });
});

describe("listSpecDiscrepancies", () => {
  test("returns empty array when none exist", () => {
    expect(listSpecDiscrepancies(db, SPEC_ID)).toEqual([]);
  });

  test("returns all discrepancies for spec in order", async () => {
    insertSpecDiscrepancy(db, { id: "d-first", ...MINIMAL });
    await new Promise((r) => setTimeout(r, 5));
    insertSpecDiscrepancy(db, { id: "d-second", ...MINIMAL, spec_assumption: "Other assumption", code_reality: "Other reality" });

    const all = listSpecDiscrepancies(db, SPEC_ID);
    expect(all).toHaveLength(2);
    expect(all[0]!.id).toBe("d-first");
    expect(all[1]!.id).toBe("d-second");
  });

  test("does not return discrepancies from another spec", () => {
    insertSpec(db, { id: "spec-2", project_id: PROJECT_ID, title: "S2" });
    insertSpecDiscrepancy(db, { id: "da", ...MINIMAL });
    insertSpecDiscrepancy(db, { id: "db", spec_id: "spec-2", spec_assumption: "X", code_reality: "Y", status: "open" });

    expect(listSpecDiscrepancies(db, SPEC_ID)).toHaveLength(1);
    expect(listSpecDiscrepancies(db, "spec-2")).toHaveLength(1);
  });
});

describe("countOpenDiscrepancies", () => {
  test("returns 0 when none exist", () => {
    expect(countOpenDiscrepancies(db, SPEC_ID)).toBe(0);
  });

  test("counts only open rows, ignoring resolved and waived", () => {
    insertSpecDiscrepancy(db, { id: "c1", ...MINIMAL, status: "open" });
    insertSpecDiscrepancy(db, { id: "c2", ...MINIMAL, spec_assumption: "B", code_reality: "B2", status: "resolved" });
    insertSpecDiscrepancy(db, { id: "c3", ...MINIMAL, spec_assumption: "C", code_reality: "C2", status: "waived" });
    insertSpecDiscrepancy(db, { id: "c4", ...MINIMAL, spec_assumption: "D", code_reality: "D2", status: "open" });

    expect(countOpenDiscrepancies(db, SPEC_ID)).toBe(2);
  });

  test("does not count open discrepancies from another spec", () => {
    insertSpec(db, { id: "spec-x", project_id: PROJECT_ID, title: "X" });
    insertSpecDiscrepancy(db, { id: "cx", spec_id: "spec-x", spec_assumption: "A", code_reality: "B", status: "open" });

    expect(countOpenDiscrepancies(db, SPEC_ID)).toBe(0);
  });
});

describe("updateSpecDiscrepancy", () => {
  test("updates status to resolved", () => {
    insertSpecDiscrepancy(db, { id: "u1", ...MINIMAL });
    const updated = updateSpecDiscrepancy(db, "u1", { status: "resolved" });
    expect(updated?.status).toBe("resolved");
  });

  test("updates resolution text", () => {
    insertSpecDiscrepancy(db, { id: "u2", ...MINIMAL });
    const updated = updateSpecDiscrepancy(db, "u2", { resolution: "Spec was wrong, code is correct" });
    expect(updated?.resolution).toBe("Spec was wrong, code is correct");
  });

  test("clears resolution back to null", () => {
    insertSpecDiscrepancy(db, { id: "u3", ...MINIMAL, resolution: "text", status: "resolved" });
    const updated = updateSpecDiscrepancy(db, "u3", { resolution: null });
    expect(updated?.resolution).toBeNull();
  });

  test("returns null for unknown id", () => {
    expect(updateSpecDiscrepancy(db, "nope", { status: "waived" })).toBeNull();
  });

  test("no-op update returns current row", () => {
    insertSpecDiscrepancy(db, { id: "u4", ...MINIMAL });
    const result = updateSpecDiscrepancy(db, "u4", {});
    expect(result?.id).toBe("u4");
    expect(result?.status).toBe("open");
  });
});
