import { expect, test } from "bun:test";
import { sql } from "kysely";
import type { Database } from "../src/storage/database";
import { integration, scratchDatabase } from "./grading-fixture";
import { DISCARDED_TABLES, TARGET_FUNCTIONS, TARGET_SECONDARY_INDEXES, TARGET_TABLES, TARGET_TRIGGERS } from "./target-schema";

test("the storage suites require OAKRIDGE_TEST_DATABASE_URL rather than skipping green", () => {
  expect(process.env.OAKRIDGE_TEST_DATABASE_URL).toBeTruthy();
});

const sorted = (values: readonly string[]): readonly string[] => [...values].sort();

async function columnsOf(db: Database): Promise<Record<string, string[]>> {
  const rows = await sql<{ table_name: string; spec: string }>`SELECT c.relname AS table_name,
    a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
      || CASE WHEN a.attnotnull THEN '' ELSE ' null' END
      || CASE WHEN d.adbin IS NULL THEN '' ELSE ' default' END AS spec
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
    WHERE n.nspname = 'observation' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY c.relname, a.attnum`.execute(db);
  const tables: Record<string, string[]> = {};
  for (const row of rows.rows) (tables[row.table_name] ??= []).push(row.spec.replace("timestamp with time zone", "timestamptz"));
  return tables;
}

interface ConstraintRow { readonly table_name: string; readonly type: string; readonly columns: string; readonly foreign_table: string | null; readonly foreign_columns: string | null }
async function constraintsOf(db: Database): Promise<readonly ConstraintRow[]> {
  return (await sql<ConstraintRow>`SELECT c.relname AS table_name, con.contype::text AS type,
      (SELECT string_agg(a.attname, ',' ORDER BY k.ordinality) FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ordinality)
        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS columns,
      f.relname AS foreign_table,
      (SELECT string_agg(a.attname, ',' ORDER BY k.ordinality) FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ordinality)
        JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS foreign_columns
    FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_class f ON f.oid = con.confrelid WHERE n.nspname = 'observation'`.execute(db)).rows;
}

type ChecksByTable = Readonly<Record<string, readonly string[]>>;
interface CheckRow { readonly table_name: string; readonly name: string; readonly definition: string }
interface CheckDrift { readonly table: string; readonly missing: readonly string[]; readonly unexpected: readonly string[] }

async function checkRows(db: Database, schema: string): Promise<readonly CheckRow[]> {
  return (await sql<CheckRow>`SELECT c.relname AS table_name, con.conname AS name, pg_get_constraintdef(con.oid) AS definition
    FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${schema} AND con.contype = 'c'`.execute(db)).rows;
}

const groupedChecks = (rows: readonly CheckRow[]): ChecksByTable => {
  const tables: Record<string, string[]> = Object.fromEntries(Object.keys(TARGET_TABLES).map((table) => [table, []]));
  for (const row of rows) (tables[row.table_name] ??= []).push(row.definition);
  return tables;
};

/** PostgreSQL parses the inventory against the target column types, so both sides share one normal form. */
async function normalizedChecks(db: Database, inventory: ChecksByTable): Promise<ChecksByTable> {
  return db.transaction().execute(async (trx) => {
    await sql`CREATE SCHEMA expected_checks`.execute(trx);
    for (const [table, predicates] of Object.entries(inventory)) {
      await sql`CREATE TABLE ${sql.table(`expected_checks.${table}`)} (LIKE ${sql.table(`observation.${table}`)})`.execute(trx);
      for (const predicate of predicates)
        await sql`ALTER TABLE ${sql.table(`expected_checks.${table}`)} ADD CHECK (${sql.raw(predicate)})`.execute(trx);
    }
    const normalized = groupedChecks(await checkRows(trx, "expected_checks"));
    await sql`DROP SCHEMA expected_checks CASCADE`.execute(trx);
    return normalized;
  });
}

const targetInventory = (): ChecksByTable => Object.fromEntries(Object.entries(TARGET_TABLES).map(([table, spec]) => [table, spec.checks]));

const withoutEach = (values: readonly string[], removed: readonly string[]): readonly string[] => {
  const remaining = [...values];
  for (const value of removed) {
    const index = remaining.indexOf(value);
    if (index >= 0) remaining.splice(index, 1);
  }
  return remaining;
};

/** The exact-schema comparison: every difference between two sets of predicates, duplicates included. */
function checkDrift(expected: ChecksByTable, actual: ChecksByTable): readonly CheckDrift[] {
  return [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort().flatMap((table) => {
    const wanted = expected[table] ?? [];
    const applied = actual[table] ?? [];
    const missing = sorted(withoutEach(wanted, applied));
    const unexpected = sorted(withoutEach(applied, wanted));
    return missing.length === 0 && unexpected.length === 0 ? [] : [{ table, missing, unexpected }];
  });
}

async function appliedChecks(db: Database): Promise<ChecksByTable> {
  return groupedChecks(await checkRows(db, "observation"));
}

async function replaceCheck(db: Database, row: CheckRow, definition: string): Promise<void> {
  const table = sql.table(`observation.${row.table_name}`);
  await sql`ALTER TABLE ${table} DROP CONSTRAINT ${sql.ref(row.name)}`.execute(db);
  await sql`ALTER TABLE ${table} ADD CONSTRAINT ${sql.ref(row.name)} ${sql.raw(definition)}`.execute(db);
}

const totalChecks = (checks: ChecksByTable): number => Object.values(checks).reduce((total, predicates) => total + predicates.length, 0);

integration("the fresh baseline has exactly the sixteen target tables and every target column", async () => scratchDatabase(async (db) => {
  const actual = await columnsOf(db);
  expect(sorted(Object.keys(actual))).toEqual(sorted(Object.keys(TARGET_TABLES)));
  expect(Object.keys(actual)).toHaveLength(16);
  for (const [table, spec] of Object.entries(TARGET_TABLES)) expect({ table, columns: actual[table] }).toEqual({ table, columns: [...spec.columns] });
}));

integration("every key and tenant reference matches the target inventory", async () => scratchDatabase(async (db) => {
  const constraints = await constraintsOf(db);
  for (const [table, spec] of Object.entries(TARGET_TABLES)) {
    const own = constraints.filter((row) => row.table_name === table);
    expect({ table, primary: own.filter((row) => row.type === "p").map((row) => row.columns) }).toEqual({ table, primary: [spec.primary_key] });
    expect({ table, unique: sorted(own.filter((row) => row.type === "u").map((row) => row.columns)) }).toEqual({ table, unique: sorted(spec.unique) });
    expect({ table, foreign: sorted(own.filter((row) => row.type === "f").map((row) => `${row.columns} -> ${row.foreign_table}(${row.foreign_columns})`)) })
      .toEqual({ table, foreign: sorted(spec.foreign_keys) });
  }
  const tenantless = constraints.filter((row) => row.type === "f" && !row.columns.startsWith("producer,namespace,"));
  expect(tenantless).toEqual([]);
}));

integration("every CHECK predicate matches the target inventory", async () => scratchDatabase(async (db) => {
  const expected = await normalizedChecks(db, targetInventory());
  expect(totalChecks(expected)).toBe(Object.values(TARGET_TABLES).reduce((total, spec) => total + spec.checks.length, 0));
  expect(checkDrift(expected, await appliedChecks(db))).toEqual([]);
}));

integration("the comparison ignores how an equivalent predicate is written", async () => scratchDatabase(async (db) => {
  const expected = await normalizedChecks(db, { evidence_set: ["readiness IN ('not_ready', 'ready')"] });
  const rewritten = await normalizedChecks(db, { evidence_set: ["((readiness   =  ANY (ARRAY['not_ready', 'ready'])))"] });
  expect(checkDrift(expected, rewritten)).toEqual([]);
}));

integration("replacing any check with CHECK (true) or a vacuous predicate fails at an unchanged count", async () => scratchDatabase(async (db) => {
  const expected = await normalizedChecks(db, targetInventory());
  const rows = await checkRows(db, "observation");
  for (const row of rows) {
    const predicate = row.definition.replace(/^CHECK /, "");
    for (const replacement of ["CHECK (true)", `CHECK (${predicate} OR true)`]) {
      await replaceCheck(db, row, replacement);
      const actual = await appliedChecks(db);
      const [applied] = (await checkRows(db, "observation")).filter((candidate) => candidate.name === row.name && candidate.table_name === row.table_name);
      expect(totalChecks(actual)).toBe(rows.length);
      expect(checkDrift(expected, actual)).toEqual([{ table: row.table_name, missing: [row.definition], unexpected: [applied!.definition] }]);
      await replaceCheck(db, row, row.definition);
    }
  }
  expect(checkDrift(expected, await appliedChecks(db))).toEqual([]);
}), 120_000);

const CHANGED_PREDICATES: readonly (readonly [table: string, original: string, changed: string])[] = [
  ["evidence_set", "readiness IN ('not_ready', 'ready')", "readiness IN ('not_ready', 'ready', 'stale')"],
  ["evaluation_execution", "terminal_cause IS NULL OR status = 'failed'", "terminal_cause IS NULL OR status IN ('failed', 'completed')"],
  ["item_relation", "type <> 'split_from' OR asserted_by = 'human'", "type <> 'split_from' OR asserted_by IN ('human', 'inferred')"],
  ["grading_provider_attempt", "attempt > 0", "attempt >= 0"],
  ["grade_observation", "confidence IS NULL OR (confidence >= 0 AND confidence <= 1)", "confidence IS NULL OR (confidence >= 0 AND confidence <= 100)"],
];

integration("a different predicate with the same name fails at an unchanged count", async () => scratchDatabase(async (db) => {
  const expected = await normalizedChecks(db, targetInventory());
  const rows = await checkRows(db, "observation");
  for (const [table, original, changed] of CHANGED_PREDICATES) {
    expect(TARGET_TABLES[table]!.checks).toContain(original);
    const [wanted] = (await normalizedChecks(db, { [table]: [original] }))[table]!;
    const [replacement] = (await normalizedChecks(db, { [table]: [changed] }))[table]!;
    const row = rows.find((candidate) => candidate.table_name === table && candidate.definition === wanted)!;
    await replaceCheck(db, row, replacement!);
    const actual = await appliedChecks(db);
    expect(totalChecks(actual)).toBe(rows.length);
    expect(checkDrift(expected, actual)).toEqual([{ table, missing: [wanted!], unexpected: [replacement!] }]);
    await replaceCheck(db, row, row.definition);
  }
}), 60_000);

integration("an unvalidated, duplicated or missing check is drift", async () => scratchDatabase(async (db) => {
  const expected = await normalizedChecks(db, targetInventory());
  const row = (await checkRows(db, "observation")).find((candidate) => candidate.table_name === "grading_provider_attempt" && candidate.definition.includes("attempt > 0"))!;
  await replaceCheck(db, row, `${row.definition} NOT VALID`);
  expect(checkDrift(expected, await appliedChecks(db))).toEqual([{ table: row.table_name, missing: [row.definition], unexpected: [`${row.definition} NOT VALID`] }]);
  await replaceCheck(db, row, row.definition);
  await sql`ALTER TABLE observation.grading_provider_attempt ADD CONSTRAINT duplicate_attempt ${sql.raw(row.definition)}`.execute(db);
  expect(checkDrift(expected, await appliedChecks(db))).toEqual([{ table: row.table_name, missing: [], unexpected: [row.definition] }]);
  await sql`ALTER TABLE observation.grading_provider_attempt DROP CONSTRAINT duplicate_attempt`.execute(db);
  await sql`ALTER TABLE observation.grading_provider_attempt DROP CONSTRAINT ${sql.ref(row.name)}`.execute(db);
  expect(checkDrift(expected, await appliedChecks(db))).toEqual([{ table: row.table_name, missing: [row.definition], unexpected: [] }]);
}));

integration("triggers, functions, indexes and row security match, with no discarded exemption", async () => scratchDatabase(async (db) => {
  const triggers = await sql<{ table_name: string; name: string }>`SELECT c.relname AS table_name, t.tgname AS name FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'observation' AND NOT t.tgisinternal`.execute(db);
  const byTable: Record<string, string[]> = {};
  for (const row of triggers.rows) (byTable[row.table_name] ??= []).push(row.name);
  expect(Object.fromEntries(Object.entries(byTable).map(([table, names]) => [table, sorted(names)]))).toEqual(TARGET_TRIGGERS);
  const functions = await sql<{ name: string; body: string }>`SELECT p.proname AS name, p.prosrc AS body FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'observation'`.execute(db);
  expect(sorted(functions.rows.map((row) => row.name))).toEqual(sorted(TARGET_FUNCTIONS));
  expect(functions.rows.filter((row) => /purge|export|blind|override/i.test(row.body))).toEqual([]);
  const indexes = await sql<{ name: string }>`SELECT i.relname AS name FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_class t ON t.oid = x.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'observation' AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = i.oid)`.execute(db);
  expect(sorted(indexes.rows.map((row) => row.name))).toEqual(sorted(TARGET_SECONDARY_INDEXES));
  const security = await sql<{ name: string; forced: boolean; policies: number }>`SELECT c.relname AS name, c.relforcerowsecurity AS forced,
      (SELECT count(*)::integer FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'observation' AND c.relkind = 'r'`.execute(db);
  for (const table of security.rows) expect(table).toEqual(table.name === "schema_baseline"
    ? { name: table.name, forced: false, policies: 0 } : { name: table.name, forced: true, policies: 1 });
  const discarded = await sql<{ name: string | null }>`SELECT to_regclass(${`observation.${DISCARDED_TABLES[0]}`})::text AS name`.execute(db);
  expect(discarded.rows).toEqual([{ name: null }]);
}));

integration("the generated records name exactly the target tables and columns", async () => scratchDatabase(async () => {
  const records = await Bun.file(new URL("../src/storage/db-types.ts", import.meta.url)).text();
  for (const [table, spec] of Object.entries(TARGET_TABLES)) {
    const name = `Observation${table.split("_").map((part) => part[0]!.toUpperCase() + part.slice(1)).join("")}`;
    const body = new RegExp(`export interface ${name} \\{\\n([\\s\\S]*?)\\n\\}`).exec(records)?.[1] ?? "";
    expect({ table, columns: body.split("\n").map((line) => line.trim().split(":")[0]) })
      .toEqual({ table, columns: spec.columns.map((column) => column.split(" ")[0]) });
  }
  expect([...records.matchAll(/^  "observation\.(\w+)":/gm)].map((match) => match[1])).toEqual(Object.keys(TARGET_TABLES));
}));
