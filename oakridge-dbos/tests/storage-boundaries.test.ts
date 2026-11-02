import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

/**
 * Rescue spec §1 rules 3–5, enforced over `src`:
 * - 3: workflow-state tables are written only by commit, with the narrow
 *   exceptions the named stores own;
 * - 4: no raw `sql` or `.query(` outside the stream boundary, migrate and `anyOf`;
 * - 5: no query building outside storage/.
 */
const src = resolve(import.meta.dir, "../src");
interface SourceFile { readonly path: string; readonly text: string }
function sources(directory = src): SourceFile[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [{ path: relative(src, path), text: readFileSync(path, "utf8") }] : [];
  });
}

/** A Kysely `sql` template (optionally typed) or one of its helpers. */
const SQL_TEMPLATE = /\bsql\s*(<[^`]*>)?\s*`|\bsql\.(raw|ref|lit|id|join|val|table)\b/;
/** A driver call handed SQL text. */
const DRIVER_QUERY = /\.query\s*(<[^(]*>)?\s*\(\s*[`'"]\s*(SELECT|INSERT|UPDATE|DELETE|WITH|CREATE|DROP|ALTER|BEGIN)\b/i;
const QUERY_BUILDING = new RegExp(`\\b(selectFrom|insertInto|updateTable|deleteFrom)\\s*\\(|${SQL_TEMPLATE.source}|${DRIVER_QUERY.source}`, "i");
const isRawSql = (line: string): boolean => SQL_TEMPLATE.test(line) || DRIVER_QUERY.test(line);
/** Snapshot expressions and the one guarded stream reader are the read store's SQL boundary. */
const STREAM_BOUNDARY = /pg_current_snapshot|pg_snapshot_xmin|pg_visible_in_snapshot|::xid8/;

export function queryOutsideStorage(files: readonly SourceFile[]): readonly string[] {
  return files.filter((file) => !file.path.startsWith("storage/") && QUERY_BUILDING.test(file.text)).map((file) => file.path);
}
export function rawSqlViolations(files: readonly SourceFile[]): readonly string[] {
  return files.flatMap((file) => {
    const lines = file.text.split("\n");
    const streamStart = file.path === "storage/read-store.ts"
      ? lines.findIndex((line) => line.includes('export async function readCommittedEventsAfter(db: Reader, table: "authority.event" | "authority.operator_event"')) : -1;
    const streamEnd = streamStart < 0 ? -1 : lines.findIndex((line, index) => index > streamStart && line.startsWith("/** The stage pinned"));
    return lines.flatMap((line, index) => {
      if (!isRawSql(line)) return [];
      if (file.path === "storage/migrate.ts") return [];
      if (file.path === "storage/database.ts" && /ANY\(/.test(line)) return [];
      if (file.path === "storage/read-store.ts" && (STREAM_BOUNDARY.test(line)
        || streamStart >= 0 && streamEnd > streamStart && index >= streamStart && index < streamEnd)) return [];
      return [`${file.path}:${index + 1}`];
    });
  });
}

const WORKFLOW_STATE = ["run", "unit", "unit_dependency", "attempt", "artifact_revision", "review_decision", "event", "wanted_log",
  "effect_intent", "ingress_receipt", "operator_event"] as const;
type Write = "insertInto" | "updateTable" | "deleteFrom";
/** Who besides commit may write which workflow-state table, and how (rescue spec §2.2). */
const SANCTIONED: { readonly [path: string]: { readonly [table: string]: readonly Write[] } } = {
  "storage/commit.ts": Object.fromEntries(WORKFLOW_STATE.map((table) => [table, ["insertInto", "updateTable"]])),
  "storage/executor-store.ts": { effect_intent: ["updateTable"] },
  "storage/registry-store.ts": { operator_event: ["insertInto"], run: ["updateTable"] },
  "storage/run-deletion.ts": { ...Object.fromEntries(WORKFLOW_STATE.map((table) => [table, ["deleteFrom"]])),
    run: ["deleteFrom", "updateTable"], operator_event: ["insertInto"] },
};
export function workflowStateWrites(files: readonly SourceFile[]): readonly string[] {
  return files.flatMap((file) => [...file.text.matchAll(/\b(insertInto|updateTable|deleteFrom)\s*\(\s*"authority\.(\w+)"/g)].flatMap((match) => {
    const [, write, table] = match as unknown as [string, Write, string];
    if (!(WORKFLOW_STATE as readonly string[]).includes(table)) return [];
    return SANCTIONED[file.path]?.[table]?.includes(write) ? [] : [`${file.path}: ${write} ${table}`];
  }));
}

const files = sources();

test("query building stays inside storage/", () => {
  expect(queryOutsideStorage(files)).toEqual([]);
});

test("raw SQL appears only in migrate, the anyOf helper and the stream boundary", () => {
  expect(rawSqlViolations(files)).toEqual([]);
});

test("workflow-state tables are written only by commit and the stores sanctioned for it", () => {
  expect(workflowStateWrites(files)).toEqual([]);
});

test("a pg pool or client is created only by the database factory", () => {
  expect(files.filter((file) => file.path !== "storage/database.ts" && /from "pg"/.test(file.text)).map((file) => file.path)).toEqual([]);
});

test("each check fails on an injected violation", () => {
  const injected = (path: string, text: string): SourceFile[] => [{ path, text }];
  expect({
    query: queryOutsideStorage(injected("http/app.ts", 'db.selectFrom("authority.run")')),
    raw: rawSqlViolations(injected("storage/read-store.ts", "await sql`SELECT 1`.execute(db);")),
    driver: rawSqlViolations(injected("storage/commit.ts", "await client.query('SELECT 1');")),
    write: workflowStateWrites(injected("storage/registry-store.ts", 'trx.insertInto("authority.event")')),
  }).toEqual({ query: ["http/app.ts"], raw: ["storage/read-store.ts:1"], driver: ["storage/commit.ts:1"], write: ["storage/registry-store.ts: insertInto event"] });
});
