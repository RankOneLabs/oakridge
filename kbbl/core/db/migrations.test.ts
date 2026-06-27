import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { applyMigrations } from "./migrations";
import { openTestDb } from "./test-db";

let migrationsDir: string;
let db: Database;

beforeEach(() => {
  migrationsDir = mkdtempSync(join(tmpdir(), "kbbl-migrations-test-"));
  db = new Database(":memory:");
});

afterEach(() => {
  db.close();
  rmSync(migrationsDir, { recursive: true, force: true });
});

describe("applyMigrations", () => {
  test("creates _migrations table and applies files in order", () => {
    writeFileSync(
      join(migrationsDir, "001_first.sql"),
      "CREATE TABLE foo (id INTEGER PRIMARY KEY);",
    );
    writeFileSync(
      join(migrationsDir, "002_second.sql"),
      "CREATE TABLE bar (id INTEGER PRIMARY KEY);",
    );

    const { applied } = applyMigrations(db, migrationsDir);

    expect(applied).toEqual(["001_first.sql", "002_second.sql"]);
    const rows = db.query<{ name: string }, []>("SELECT name FROM _migrations ORDER BY name").all();
    expect(rows.map((r) => r.name)).toEqual(["001_first.sql", "002_second.sql"]);
    // Both tables exist
    db.exec("SELECT 1 FROM foo");
    db.exec("SELECT 1 FROM bar");
  });

  test("is idempotent — second run applies nothing new", () => {
    writeFileSync(
      join(migrationsDir, "001_first.sql"),
      "CREATE TABLE foo (id INTEGER PRIMARY KEY);",
    );

    applyMigrations(db, migrationsDir);
    const { applied } = applyMigrations(db, migrationsDir);

    expect(applied).toEqual([]);
  });

  test("ignores files that do not match the pattern", () => {
    writeFileSync(join(migrationsDir, "README.md"), "docs");
    writeFileSync(join(migrationsDir, "01_bad_prefix.sql"), "SELECT 1;");
    writeFileSync(join(migrationsDir, "001_Valid.sql"), "SELECT 1;"); // uppercase V
    writeFileSync(join(migrationsDir, "001_valid.sql.bak"), "SELECT 1;");
    writeFileSync(join(migrationsDir, "001_ok.sql"), "CREATE TABLE ok (id INTEGER);");

    const { applied } = applyMigrations(db, migrationsDir);

    expect(applied).toEqual(["001_ok.sql"]);
  });

  test("throws on SQL error and leaves migration unrecorded", () => {
    writeFileSync(join(migrationsDir, "001_bad.sql"), "NOT VALID SQL!!!;");

    expect(() => applyMigrations(db, migrationsDir)).toThrow();

    const rows = db.query<{ name: string }, []>("SELECT name FROM _migrations").all();
    expect(rows).toHaveLength(0);
  });

  test("applies only new migrations when some are already recorded", () => {
    writeFileSync(
      join(migrationsDir, "001_first.sql"),
      "CREATE TABLE foo (id INTEGER PRIMARY KEY);",
    );

    applyMigrations(db, migrationsDir);

    writeFileSync(
      join(migrationsDir, "002_second.sql"),
      "CREATE TABLE bar (id INTEGER PRIMARY KEY);",
    );

    const { applied } = applyMigrations(db, migrationsDir);

    expect(applied).toEqual(["002_second.sql"]);
  });
});

describe("openTestDb schema after all migrations", () => {
  test("all task-tracker tables exist", () => {
    const testDb = openTestDb();
    try {
      const tables = testDb
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name",
        )
        .all()
        .map((r) => r.name);

      expect(tables).toContain("specs");
      expect(tables).toContain("plans");
      expect(tables).toContain("cohorts");
      expect(tables).toContain("cohort_dependencies");
      expect(tables).toContain("briefs");
    } finally {
      testDb.close();
    }
  });
});

describe("split model migration", () => {
  test("preserves pre-split codex runtime while dropping the staging column", () => {
    writeFileSync(
      join(migrationsDir, "001_seed_pre_split_epic.sql"),
      `
        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          repo_path TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE TABLE specs (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          title TEXT NOT NULL,
          notes TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE TABLE epics (
          id TEXT PRIMARY KEY,
          spec_id TEXT NOT NULL UNIQUE REFERENCES specs(id),
          project_id TEXT NOT NULL REFERENCES projects(id),
          title TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'complete', 'archived')),
          current_stage TEXT NOT NULL CHECK (current_stage IN ('spec', 'plan', 'build', 'assess')),
          agent_runtime TEXT NOT NULL CHECK (agent_runtime IN ('claude-code', 'codex')),
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX epics_project_id_status ON epics(project_id, status);
        INSERT INTO projects (id, name, repo_path) VALUES ('project-1', 'Project', '/repo');
        INSERT INTO specs (id, project_id, title) VALUES ('spec-1', 'project-1', 'Spec');
        INSERT INTO epics (
          id,
          spec_id,
          project_id,
          title,
          status,
          current_stage,
          agent_runtime
        ) VALUES (
          'epic-1',
          'spec-1',
          'project-1',
          'Epic',
          'active',
          'build',
          'codex'
        );
      `,
    );
    writeFileSync(
      join(migrationsDir, "002_split_role_models.sql"),
      readFileSync(join(import.meta.dir, "migrations/023_epic_split_role_models.sql"), "utf8"),
    );
    writeFileSync(
      join(migrationsDir, "003_drop_single_runtime.sql"),
      readFileSync(join(import.meta.dir, "migrations/024_drop_epic_single_runtime.sql"), "utf8"),
    );

    applyMigrations(db, migrationsDir);

    const epic = db
      .query<
        { planner_runtime: string; planner_model: string; worker_runtime: string; worker_model: string },
        []
      >(
        "SELECT planner_runtime, planner_model, worker_runtime, worker_model FROM epics WHERE id = 'epic-1'",
      )
      .get();
    expect(epic).toEqual({
      planner_runtime: "codex",
      planner_model: "gpt-5.5",
      worker_runtime: "codex",
      worker_model: "gpt-5.4-mini",
    });

    const columns = db
      .query<{ name: string }, []>("PRAGMA table_info(epics)")
      .all()
      .map((column) => column.name);
    expect(columns).not.toContain("agent_runtime");
  });
});
