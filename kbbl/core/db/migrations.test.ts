import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  test("throws on foreign key violations and leaves migration unrecorded", () => {
    writeFileSync(
      join(migrationsDir, "001_bad_fk.sql"),
      `
        PRAGMA foreign_keys = OFF;
        CREATE TABLE parent (id TEXT PRIMARY KEY);
        CREATE TABLE child (
          id TEXT PRIMARY KEY,
          parent_id TEXT NOT NULL REFERENCES parent(id)
        );
        INSERT INTO child (id, parent_id) VALUES ('child-1', 'missing-parent');
        PRAGMA foreign_keys = ON;
      `,
    );

    expect(() => applyMigrations(db, migrationsDir)).toThrow(/foreign key check/);

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
