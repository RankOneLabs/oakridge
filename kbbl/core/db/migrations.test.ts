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

  test("foreign-key-disabled migrations still roll back before recording", () => {
    db.exec("PRAGMA foreign_keys = ON");
    writeFileSync(
      join(migrationsDir, "001_bad_rebuild.sql"),
      `
        -- kbbl:disable_foreign_keys
        CREATE TABLE rebuilt (id TEXT PRIMARY KEY);
        NOT VALID SQL!!!;
      `,
    );

    expect(() => applyMigrations(db, migrationsDir)).toThrow();

    const rows = db.query<{ name: string }, []>("SELECT name FROM _migrations").all();
    expect(rows).toHaveLength(0);
    const table = db.query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE name = 'rebuilt'").get();
    expect(table).toBeNull();
    const foreignKeys = db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get();
    expect(foreignKeys?.foreign_keys).toBe(1);
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

  test("refuses a database built by a different migration history", () => {
    writeFileSync(join(migrationsDir, "001_first.sql"), "CREATE TABLE foo (id INTEGER PRIMARY KEY);");
    db.exec("CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    db.exec("INSERT INTO _migrations VALUES ('001_projects.sql', '2026-01-01T00:00:00.000Z')");

    expect(() => applyMigrations(db, migrationsDir)).toThrow(/001_projects\.sql.*Move it aside/);

    const table = db.query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE name = 'foo'").get();
    expect(table).toBeNull();
  });
});

describe("the baseline schema", () => {
  test("holds exactly kbbl's session ledger", () => {
    const db = openTestDb();
    const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all().map((row) => row.name);
    expect(tables).toEqual(["_migrations", "acp_session_summaries", "acp_sessions", "acp_turns"]);
    db.close();
  });
});
