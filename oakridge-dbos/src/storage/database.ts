import { Kysely, PostgresDialect, sql, type RawBuilder, type Transaction } from "kysely";
import pg from "pg";
import type { DB } from "./db-types";
import type { JsonText } from "./json-column-types";

export type { DB } from "./db-types";
export type Database = Kysely<DB>;
export type DatabaseTransaction = Transaction<DB>;

const INT8_OID = 20;
/** int8 columns (versions, counts, transaction ids) arrive as numbers; one outside the safe range is a fault. */
function parseInt8(text: string): number {
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw new Error(`int8 value ${text} exceeds the JavaScript safe integer range`);
  return value;
}
pg.types.setTypeParser(INT8_OID, parseInt8);

/**
 * The one factory: every pool in the process is created here. `destroy()`
 * ends it. The schema defaults to the authority's; a script reading another
 * database names that database's tables instead.
 */
export function openDatabase<Schema = DB>(database_url: string): Kysely<Schema> {
  return new Kysely<Schema>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: database_url }) }) });
}

/** `= ANY($1::text[])`: one bound array parameter rather than one parameter per id. */
export function anyOf(ids: readonly string[]): RawBuilder<string> {
  return sql<string>`ANY(${[...ids]}::text[])`;
}

/** Serialize a value for a jsonb column (see JsonText). */
export function jsonText<Value>(value: Value): JsonText<Value> {
  return JSON.stringify(value) as JsonText<Value>;
}
