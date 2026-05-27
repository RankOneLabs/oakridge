import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Seeds the DB with migrations up to 012 (pre-Epic), inserts one spec per
// legacy status value, then applies 013+014 and verifies backfill correctness.

const MIGRATIONS_DIR = join(import.meta.dir, "../migrations");

// Legacy status → expected (epic.status, epic.current_stage, spec.internal_status)
const CASES = [
  { specId: "s-draft",         status: "draft",         epicStatus: "active",   epicStage: "spec",   specInternal: "analyzing" },
  { specId: "s-plan_review",   status: "plan_review",   epicStatus: "active",   epicStage: "spec",   specInternal: "analyzing" },
  { specId: "s-planning_done", status: "planning_done", epicStatus: "active",   epicStage: "build",  specInternal: "approved"  },
  { specId: "s-done",          status: "done",          epicStatus: "complete", epicStage: "review", specInternal: "approved"  },
  { specId: "s-archived",      status: "archived",      epicStatus: "archived", epicStage: "spec",   specInternal: "analyzing" },
] as const;

let db: Database;

beforeEach(() => {
  // Apply only migrations 001–012 first, then seed, then finish with 013–014.
  db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");

  // Apply all migrations up to and including 012.
  applyUpTo(db, MIGRATIONS_DIR, "012_planner3_assessments.sql");

  // Seed: one project + one spec per legacy status value.
  db.exec(`INSERT INTO projects (id, name, repo_path) VALUES ('proj-1', 'P', '/p')`);
  for (const c of CASES) {
    db.exec(
      `INSERT INTO specs (id, project_id, title, status)
       VALUES ('${c.specId}', 'proj-1', 'T-${c.specId}', '${c.status}')`,
    );
  }

  // Now apply 013 and 014.
  applyFrom(db, MIGRATIONS_DIR, "013_epics.sql");
});

afterEach(() => {
  db.close();
});

describe("migration 013 backfill: epics table", () => {
  test("creates exactly one epic per spec", () => {
    const count = (db.prepare("SELECT COUNT(*) AS n FROM epics").get() as { n: number }).n;
    expect(count).toBe(CASES.length);
  });

  for (const c of CASES) {
    test(`spec status '${c.status}' → epic status '${c.epicStatus}', stage '${c.epicStage}'`, () => {
      const row = db
        .prepare("SELECT status, current_stage FROM epics WHERE spec_id = ?")
        .get(c.specId) as { status: string; current_stage: string } | null;
      expect(row).not.toBeNull();
      expect(row!.status).toBe(c.epicStatus);
      expect(row!.current_stage).toBe(c.epicStage);
    });
  }

  test("epic title matches spec title", () => {
    for (const c of CASES) {
      const row = db
        .prepare("SELECT title FROM epics WHERE spec_id = ?")
        .get(c.specId) as { title: string } | null;
      expect(row?.title).toBe(`T-${c.specId}`);
    }
  });

  test("epic id is unique across all backfill rows", () => {
    const ids = (db.prepare("SELECT id FROM epics").all() as { id: string }[]).map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("migration 014 backfill: spec internal_status", () => {
  for (const c of CASES) {
    test(`spec status '${c.status}' → internal_status '${c.specInternal}'`, () => {
      const row = db
        .prepare("SELECT internal_status FROM specs WHERE id = ?")
        .get(c.specId) as { internal_status: string } | null;
      expect(row).not.toBeNull();
      expect(row!.internal_status).toBe(c.specInternal);
    });
  }

  test("submitted_notes column exists and is nullable", () => {
    const cols = db.prepare("PRAGMA table_info(specs)").all() as { name: string; notnull: number }[];
    const col = cols.find((c) => c.name === "submitted_notes");
    expect(col).not.toBeUndefined();
    expect(col!.notnull).toBe(0);
  });

  test("spec_discrepancies table exists and is empty after backfill", () => {
    const count = (db.prepare("SELECT COUNT(*) AS n FROM spec_discrepancies").get() as { n: number }).n;
    expect(count).toBe(0);
  });
});

// ─── helpers ─────────────────────────────────────────────────────────────────

function applyUpTo(db: Database, dir: string, lastFile: string): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);

  const files = readdirSync(dir)
    .filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))
    .sort();

  for (const file of files) {
    if (file > lastFile) break;
    if (db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get(file)) continue;
    const sql = readFileSync(join(dir, file), "utf8");
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, datetime('now'))").run(file);
    })();
  }
}

function applyFrom(db: Database, dir: string, fromFile: string): void {
  const files = readdirSync(dir)
    .filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))
    .sort();

  for (const file of files) {
    if (file < fromFile) continue;
    if (db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get(file)) continue;
    const sql = readFileSync(join(dir, file), "utf8");
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, datetime('now'))").run(file);
    })();
  }
}
