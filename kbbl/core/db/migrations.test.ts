import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { AcpSessionStore } from "../acp/store";
import type { AcpAgentSessionId, KbblSessionId, ResumableKey } from "../acp/types";
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
    expect(tables).toEqual(["_migrations", "acp_session_archives", "acp_session_summaries", "acp_sessions", "acp_turn_usage", "acp_turns", "acp_usage_reading"]);
    db.close();
  });
});

describe("kbbl ledger migrations", () => {
  const ledgerMigrations = join(import.meta.dir, "migrations");
  const dropMigration = "004_drop_gated_review.sql";
  const sessionColumns = (ledger: Database): string[] =>
    ledger.query<{ name: string }, []>("SELECT name FROM pragma_table_info('acp_sessions')").all().map((column) => column.name);
  const ledgerTables = (ledger: Database): string[] =>
    ledger.query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'acp_%' ORDER BY name").all().map((table) => table.name);
  /** Every retained ledger row, without the column 004 removes. */
  const retainedRows = (ledger: Database): Record<string, unknown[]> => Object.fromEntries(ledgerTables(ledger).map((table) => [table,
    ledger.query<Record<string, unknown>, []>(`SELECT * FROM ${table} ORDER BY rowid`).all()
      .map(({ gated_review_json: _removed, pr_integration: _integration, pr_skill_digest: _digest, ...row }) => row)]));

  function ledgerThrough003(): Database {
    const through = join(migrationsDir, "through-003");
    mkdirSync(through);
    for (const name of readdirSync(ledgerMigrations).filter((file) => file < "004")) {
      copyFileSync(join(ledgerMigrations, name), join(through, name));
    }
    const ledger = new Database(":memory:");
    ledger.exec("PRAGMA foreign_keys = ON");
    expect(applyMigrations(ledger, through).applied).toEqual(["001_sessions.sql", "002_session_archive.sql", "003_gated_review.sql"]);
    const session = ledger.prepare(`INSERT INTO acp_sessions (sid, resumable_key, start_spec_hash, agent_profile, acp_session_id, name,
        project_workdir, worktree_path, status, run_id, unit_id, worker, gated_review_json, last_activity_at, created_at, updated_at)
      VALUES (?, ?, 'hash', 'claude-code', ?, ?, '/work', '/work/tree', 'idle', ?, ?, ?, ?, 't0', 't0', 't0')`);
    session.run("sid-restricted", "key-restricted", "agent-1", "restricted", "run-1", "run-1/cohort/a", "builder", '{"kind":"restricted","role":"builder"}');
    session.run("sid-unscoped", "key-unscoped", "agent-2", "unscoped", "run-1", "run-1/cohort/a", "assessor", '{"kind":"unscoped"}');
    session.run("sid-hand", null, "agent-3", "hand-started", null, null, null, null);
    ledger.run(`INSERT INTO acp_turns (sid, turn_key, source, payload_hash, payload, status, created_at)
      VALUES ('sid-restricted', 'turn-1', 'initial', 'hash', 'build it', 'succeeded', 't0')`);
    ledger.run(`INSERT INTO acp_session_summaries (sid, schema_version, method, summary_json, produced_at, created_at, updated_at)
      VALUES ('sid-unscoped', 1, 'final_response', '{"text":"done"}', 't1', 't1', 't1')`);
    ledger.run("INSERT INTO acp_session_archives (sid, archived_at) VALUES ('sid-hand', 't2')");
    return ledger;
  }

  test("003 keeps the bytes it shipped with", () => {
    const bytes = readFileSync(join(ledgerMigrations, "003_gated_review.sql"));
    expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"))
      .toBe("0051d5c4feed3b1c3c8677f8a0b47ee0075e3e17c3115e18fe8ce5f63fdd494d");
  });

  test("a fresh database applies the complete numbered sequence and has no grant column", () => {
    const ledger = new Database(":memory:");
    const { applied } = applyMigrations(ledger, ledgerMigrations);
    expect(applied).toEqual(["001_sessions.sql", "002_session_archive.sql", "003_gated_review.sql", dropMigration, "005_session_pr_integration.sql", "006_turn_usage.sql"]);
    expect(sessionColumns(ledger)).not.toContain("gated_review_json");
    ledger.close();
  });

  test("a ledger populated through 003 loses only the grant column", () => {
    const ledger = ledgerThrough003();
    const rows = retainedRows(ledger);
    const columns = sessionColumns(ledger);
    expect(applyMigrations(ledger, ledgerMigrations).applied).toEqual([dropMigration, "005_session_pr_integration.sql", "006_turn_usage.sql"]);
    expect(sessionColumns(ledger)).toEqual([...columns.filter((column) => column !== "gated_review_json"), "pr_integration", "pr_skill_digest"]);
    expect(retainedRows(ledger)).toEqual({ ...rows, acp_turn_usage: [], acp_usage_reading: [] });
    ledger.close();
  });

  test("reapplying the runner neither repeats the drop nor loses rows", () => {
    const ledger = ledgerThrough003();
    applyMigrations(ledger, ledgerMigrations);
    const rows = retainedRows(ledger);
    expect(applyMigrations(ledger, ledgerMigrations).applied).toEqual([]);
    expect(retainedRows(ledger)).toEqual(rows);
    ledger.close();
  });

  test("an upgraded session keeps its workflow identity and resumes by key", () => {
    const ledger = ledgerThrough003();
    applyMigrations(ledger, ledgerMigrations);
    const store = new AcpSessionStore(ledger);
    const claim = { sid: "sid-new" as KbblSessionId, resumable_key: "key-restricted" as ResumableKey, start_spec_hash: "hash", agent_profile: "claude-code", name: "restricted",
      artifact_id: null, project_workdir: "/work", worktree_path: "/work/tree", requested_model: null, requested_effort: null, requested_mode: null,
      workflow: { run_id: "run-1", unit_id: "run-1/cohort/a", worker: "builder", pr_integration: "gated-review" as const, pr_skill_digest: null } };
    const claimed = store.claimResumable("key-restricted" as ResumableKey, claim);
    expect({ kind: claimed.kind, sid: claimed.row.sid, workflow: claimed.row.workflow, acp_session_id: claimed.row.acp_session_id }).toEqual({
      kind: "existing", sid: "sid-restricted" as KbblSessionId, workflow: claim.workflow, acp_session_id: "agent-1" as AcpAgentSessionId });
    expect(store.insertSession({ ...claim, sid: "sid-fresh" as KbblSessionId, resumable_key: "key-fresh" as ResumableKey }).workflow).toEqual(claim.workflow);
    ledger.close();
  });
});

test("usage migration defines columns, composite keys, status CHECK and cascading foreign keys", () => {
  const database = openTestDb();
  const columns = (table: string) => database.query<{ name: string; pk: number }, []>(`PRAGMA table_info(${table})`).all();
  expect(columns("acp_turn_usage").map(c => c.name)).toEqual([
    "sid", "turn_key", "status", "input_tokens", "output_tokens", "cached_read_tokens", "cached_write_tokens", "thought_tokens", "total_tokens", "model_usage_json", "raw_json", "recorded_at",
  ]);
  expect(columns("acp_usage_reading").map(c => c.name)).toEqual([
    "sid", "seq", "process_seq", "context_used", "context_size", "cost_amount", "cost_currency", "active_turn_key", "autonomous", "origin_kind", "received_at",
  ]);
  expect(columns("acp_turn_usage").filter(c => c.pk).map(c => c.name)).toEqual(["sid", "turn_key"]);
  expect(columns("acp_usage_reading").filter(c => c.pk).map(c => c.name)).toEqual(["sid", "seq"]);
  database.exec(`INSERT INTO acp_sessions (sid,agent_profile,name,project_workdir,worktree_path,status,last_activity_at,created_at,updated_at) VALUES ('s','fake','test','/tmp','/tmp','idle','t','t','t');
    INSERT INTO acp_turns (sid,turn_key,source,payload_hash,payload,status,created_at) VALUES ('s','t','operator','hash','hi','succeeded','t');`);
  expect(() => database.exec("INSERT INTO acp_turn_usage (sid,turn_key,status,recorded_at) VALUES ('s','t','other','t')")).toThrow();
  database.exec("INSERT INTO acp_turn_usage (sid,turn_key,status,recorded_at) VALUES ('s','t','absent','t')");
  database.exec("DELETE FROM acp_turns WHERE sid='s'");
  expect(database.query("SELECT * FROM acp_turn_usage").all()).toEqual([]);
  database.exec("INSERT INTO acp_usage_reading (sid,seq,process_seq,received_at) VALUES ('s',0,0,'t')");
  database.exec("DELETE FROM acp_sessions WHERE sid='s'");
  expect(database.query("SELECT * FROM acp_usage_reading").all()).toEqual([]);
  database.close();
});
