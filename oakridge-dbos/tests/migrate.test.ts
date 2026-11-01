import { expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { readdir, unlink } from "node:fs/promises";
import { sql } from "kysely";
import { jsonText, openDatabase } from "../src/storage/database";
import { migrateEmptyDatabase, adoptExistingDatabase } from "../src/storage/migrate";
import { migrations } from "../src/storage/migrations/manifest";
import { scratchDatabase } from "./authority-fixture";

test("an empty database takes the baseline once, and a repeat confirms it", async () => {
  const scratch = await scratchDatabase();
  const db = openDatabase(scratch.url);
  try {
    await migrateEmptyDatabase(db);
    await migrateEmptyDatabase(db);
    const baselines = await sql<{ count: number }>`SELECT count(*)::int AS count FROM authority.schema_baseline`.execute(db);
    expect(baselines.rows[0]?.count).toBe(1);
    const ledger = await sql<{ name: string; digest: string; applied_at: Date }>`SELECT name, digest, applied_at FROM authority.schema_migration`.execute(db);
    expect(ledger.rows.map((row) => row.name)).toEqual(["0001_core.sql", "0002_historical_runs.sql"]);
    expect(ledger.rows[0]?.digest).toBe(createHash("sha256").update(new Uint8Array(await Bun.file(migrations[0]!.file).arrayBuffer())).digest("hex"));
    expect(ledger.rows[0]?.applied_at).toBeInstanceOf(Date);
  } finally { await db.destroy(); await scratch.drop(); }
});

test("two processes applying the baseline concurrently apply it exactly once", async () => {
  const scratch = await scratchDatabase();
  const first = openDatabase(scratch.url);
  const second = openDatabase(scratch.url);
  try {
    await Promise.all([migrateEmptyDatabase(first), migrateEmptyDatabase(second)]);
    const baselines = await sql<{ count: number }>`SELECT count(*)::int AS count FROM authority.schema_baseline`.execute(first);
    expect(baselines.rows[0]?.count).toBe(1);
  } finally { await first.destroy(); await second.destroy(); await scratch.drop(); }
});

test("a database with other tables is refused, and changed migration bytes are detected", async () => {
  const scratch = await scratchDatabase();
  const db = openDatabase(scratch.url);
  try {
    await sql`CREATE TABLE public.stray (id int)`.execute(db);
    await expect(migrateEmptyDatabase(db)).rejects.toThrow("requires an empty database; found public.stray");
    await sql`DROP TABLE public.stray`.execute(db);
    await migrateEmptyDatabase(db);
    const path = `/tmp/authority_migration_${randomBytes(6).toString("hex")}.sql`;
    await Bun.write(path, `${await Bun.file(migrations[0]!.file).text()}\n-- changed`);
    try {
      await expect(migrateEmptyDatabase(db, [{ name: "0001_core.sql", file: new URL(`file://${path}`) }])).rejects.toThrow("0001_core.sql");
    } finally { await unlink(path); }
  } finally { await db.destroy(); await scratch.drop(); }
});

test("manifest lists every committed authority migration", async () => {
  const files = await readdir(new URL("../src/storage/migrations/", import.meta.url));
  expect(migrations.map((entry) => entry.name)).toEqual(files.filter((name) => name.endsWith(".sql")));
});

test("historic authority baseline is adopted after catalog validation", async () => {
  const scratch = await scratchDatabase();
  const db = openDatabase(scratch.url);
  try {
    const source = await Bun.file(migrations[0]!.file).text();
    await sql.raw(source).execute(db);
    await sql`INSERT INTO authority.schema_baseline (digest) VALUES (${createHash("sha256").update(source).digest("hex")})`.execute(db);
    await expect(migrateEmptyDatabase(db)).rejects.toThrow("run storage:adopt");
    expect(await adoptExistingDatabase(db, scratch.url)).toEqual([]);
    const adopted = await sql<{ name: string }>`SELECT name FROM authority.schema_migration ORDER BY ordinal`.execute(db);
    expect(adopted.rows.map((row) => row.name)).toEqual(["0001_core.sql"]);
    await migrateEmptyDatabase(db);
    const ledger = await sql<{ count: number }>`SELECT count(*)::integer AS count FROM authority.schema_migration`.execute(db);
    expect(ledger.rows[0]?.count).toBe(2);
  } finally { await db.destroy(); await scratch.drop(); }
});

test("cutover freezes existing runs independently of operator archiving", async () => {
  const scratch = await scratchDatabase();
  const db = openDatabase(scratch.url);
  try {
    await migrateEmptyDatabase(db, migrations.slice(0, 1));
    await db.insertInto("authority.definition_bundle").values({ id: "before", digest: "before", source: jsonText({}) as never,
      checked_program: jsonText({ workflow: {} }) as never }).execute();
    await db.insertInto("authority.run").values({ id: "unarchived", definition_bundle_id: "before" }).execute();
    await db.insertInto("authority.run").values({ id: "archived", definition_bundle_id: "before", archived_at: new Date() }).execute();
    await migrateEmptyDatabase(db);
    const rows = await db.selectFrom("authority.run").select(["id", "historical_read_only", "archived_at"]).orderBy("id").execute();
    expect(rows.map((row) => [row.id, row.historical_read_only, row.archived_at === null])).toEqual([
      ["archived", true, false], ["unarchived", true, true],
    ]);
    await db.insertInto("authority.run").values({ id: "new", definition_bundle_id: "before" }).execute();
    expect((await db.selectFrom("authority.run").select("historical_read_only").where("id", "=", "new")
      .executeTakeFirstOrThrow()).historical_read_only).toBe(false);
  } finally { await db.destroy(); await scratch.drop(); }
});

test("the new baseline rejects compiled bundles without a parsed workflow", async () => {
  const scratch = await scratchDatabase();
  const db = openDatabase(scratch.url);
  try {
    await migrateEmptyDatabase(db);
    await expect(db.insertInto("authority.definition_bundle").values({ id: "old", digest: "old", source: jsonText({}) as never,
      checked_program: jsonText({ digest: "old", stages: [] }) as never }).execute())
      .rejects.toThrow();
  } finally { await db.destroy(); await scratch.drop(); }
});

test("two runs each have a root unit with no parent, and ingress ids are scoped to a run", async () => {
  const scratch = await scratchDatabase();
  const db = openDatabase(scratch.url);
  try {
    await migrateEmptyDatabase(db);
    await db.insertInto("authority.definition_bundle").values({ id: "b", digest: "d", source: jsonText({}) as never,
      checked_program: jsonText({ workflow: {} }) as never }).execute();
    for (const run of ["r1", "r2"]) await db.transaction().execute(async (trx) => {
      await trx.insertInto("authority.run").values({ id: run, definition_bundle_id: "b", root_unit_id: run }).execute();
      await trx.insertInto("authority.unit").values({ id: run, run_id: run, declaration: "$root", input: jsonText({}) as never, status: jsonText({}) as never }).execute();
      await trx.insertInto("authority.ingress_receipt").values({ id: `${run}-receipt`, run_id: run, ingress_id: "same", request_digest: "x", result: jsonText({}) as never }).execute();
    });
    const units = await db.selectFrom("authority.unit").select("id").execute();
    expect(units.length).toBe(2);
  } finally { await db.destroy(); await scratch.drop(); }
});

test("the baseline indexes units by parent, the wanted log by event and collaboration rows by their run and parent", async () => {
  const scratch = await scratchDatabase();
  const db = openDatabase(scratch.url);
  try {
    await migrateEmptyDatabase(db);
    const indexes = await sql<{ table_name: string; columns: string }>`SELECT index_table.relname AS table_name,
        string_agg(attribute.attname, ',' ORDER BY key.ordinality) AS columns
      FROM pg_index AS idx JOIN pg_class AS index_table ON index_table.oid = idx.indrelid
      JOIN pg_namespace AS namespace ON namespace.oid = index_table.relnamespace AND namespace.nspname = 'authority'
      CROSS JOIN LATERAL unnest(idx.indkey) WITH ORDINALITY AS key(attnum, ordinality)
      JOIN pg_attribute AS attribute ON attribute.attrelid = idx.indrelid AND attribute.attnum = key.attnum
      GROUP BY idx.indexrelid, index_table.relname`.execute(db);
    const indexed = new Set(indexes.rows.map((row) => `${row.table_name}(${row.columns})`));
    const wanted = ["unit(run_id,parent_id)", "wanted_log(run_id,event_id)", "collaboration_thread(run_id,unit_id,artifact_revision_id)",
      "collaboration_message(run_id,thread_id)", "review_item(run_id,thread_id)"];
    expect(wanted.filter((index) => !indexed.has(index))).toEqual([]);
  } finally { await db.destroy(); await scratch.drop(); }
});
