import { Kysely, PostgresDialect, sql, type RawBuilder, type Transaction } from "kysely";
import pg from "pg";
import type { DB } from "./db-types";
import type { JsonValue } from "../domain/primitives";

export type Database = Kysely<DB>;
export type DatabaseTransaction = Transaction<DB>;
/** Encode JSON explicitly so pg cannot interpret arrays or strings as SQL values. */
export function jsonText(value: JsonValue): RawBuilder<JsonValue> {
  return sql<JsonValue>`${JSON.stringify(value)}::jsonb`;
}
export function openDatabase(database_url: string): Database {
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: database_url }) }) });
}

export interface TenantScope { readonly producer: string; readonly namespace: string }
export async function withTenant<Value>(db: Database, tenant: TenantScope, work: (trx: DatabaseTransaction) => Promise<Value>): Promise<Value> {
  return db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('observation.producer', ${tenant.producer}, true), set_config('observation.namespace', ${tenant.namespace}, true)`.execute(trx);
    return work(trx);
  });
}
