import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Client } from "pg";
import { sql } from "kysely";
import { openDatabase, type Database } from "../src/storage/database";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { cutoverPreflight } from "../scripts/cutover-preflight";
import { scratchDatabase } from "./authority-fixture";

async function authorityFingerprint(url: string): Promise<string> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const catalog = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'authority' AND table_type = 'BASE TABLE' ORDER BY table_name`);
    const contents = [];
    for (const row of catalog.rows as { table_name: string }[]) {
      const data = await client.query(`SELECT to_jsonb(t) AS row FROM authority.${row.table_name} t`);
      contents.push([row.table_name, data.rows.map((item) => JSON.stringify(item.row)).sort()]);
    }
    const columns = await client.query(`SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'authority' ORDER BY table_name, ordinal_position`);
    const indexes = await client.query(`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'authority' ORDER BY tablename, indexname`);
    return createHash("sha256").update(JSON.stringify({ contents, columns: columns.rows, indexes: indexes.rows })).digest("hex");
  } finally { await client.end(); }
}

async function seedPreflightData(authority: Database): Promise<void> {
  await sql`INSERT INTO authority.definition_bundle (id, digest, source, checked_program, prompts)
    VALUES ('bundle-pinned', 'bundle-digest', '{}'::jsonb, '{"workflow":{}}'::jsonb,
      '{"missing-prompt":"absent-digest"}'::jsonb)`.execute(authority);
  // This scratch fixture deliberately includes a dangling reference for the report to find.
  await sql`ALTER TABLE authority.run DROP CONSTRAINT run_definition_bundle_id_fkey`.execute(authority);
  await sql`INSERT INTO authority.run (id, definition_bundle_id) VALUES
    ('run-running', 'bundle-pinned'), ('run-complete', 'bundle-pinned'),
    ('run-dangling', 'bundle-missing')`.execute(authority);
  await sql`INSERT INTO authority.unit (id, run_id, declaration, status) VALUES
    ('root-running', 'run-running', 'root', '{"kind":"running"}'::jsonb),
    ('root-complete', 'run-complete', 'root', '{"kind":"completed"}'::jsonb)`.execute(authority);
  await sql`UPDATE authority.run SET root_unit_id = 'root-running' WHERE id = 'run-running'`.execute(authority);
  await sql`UPDATE authority.run SET root_unit_id = 'root-complete' WHERE id = 'run-complete'`.execute(authority);
  await sql`INSERT INTO authority.attempt (action_id, seq, run_id, unit_id, worker, mode, cause, status)
    VALUES ('action-running', 0, 'run-running', 'root-running', 'builder', '{}'::jsonb,
      '{}'::jsonb, '{"kind":"running"}'::jsonb)`.execute(authority);
  await sql`INSERT INTO authority.effect_intent (id, run_id, unit_id, action_id, seq, payload, status) VALUES
    ('intent-pending', 'run-running', 'root-running', 'effect-pending', 0, '{}'::jsonb, 'pending')`.execute(authority);
  await sql`INSERT INTO authority.effect_intent (id, run_id, unit_id, action_id, seq, payload, status, stop_origin) VALUES
    ('intent-stopping', 'run-running', 'root-running', 'effect-stopping', 0, '{}'::jsonb,
      'stop_requested', 'executor')`.execute(authority);
}

test("cutover preflight reports runs, pending work and missing pins without changing rows or schema", async () => {
  const scratch = await scratchDatabase();
  const authority = openDatabase(scratch.url);
  try {
    await migrateEmptyDatabase(authority);
    await seedPreflightData(authority);
    const before = await authorityFingerprint(scratch.url);
    const report = await cutoverPreflight(scratch.url);
    expect(report.run_states).toEqual([
      { state: "completed", count: 1 }, { state: "not_started", count: 1 }, { state: "running", count: 1 },
    ]);
    expect(report.pending_authority_work).toEqual([
      { kind: "running_attempt", count: 1 }, { kind: "effect_intent:pending", count: 1 },
      { kind: "effect_intent:stop_requested", count: 1 },
    ]);
    expect(report.referenced_definition_ids).toEqual([
      { id: "bundle-missing", count: 1 }, { id: "bundle-pinned", count: 2 },
    ]);
    expect(report.missing_pinned_dependencies).toEqual([
      { kind: "definition_bundle", id: "bundle-missing" }, { kind: "prompt_content", id: "missing-prompt" },
    ]);
    expect(await authorityFingerprint(scratch.url)).toBe(before);
  } finally { await authority.destroy(); await scratch.drop(); }
});
