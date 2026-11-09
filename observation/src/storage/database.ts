import { Kysely, PostgresDialect, sql, type RawBuilder, type Transaction } from "kysely";
import pg from "pg";
import type { DB } from "./db-types";

export type Database = Kysely<DB>;
export type DatabaseTransaction = Transaction<DB>;
/** Encode JSON explicitly so pg cannot interpret arrays or strings as SQL values. */
export function jsonText<Value>(value: Value): RawBuilder<Value> {
  return sql<Value>`${JSON.stringify(value)}::jsonb`;
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
/** A read of several tables from one snapshot, so what it derives never mixes two commits. */
export async function withTenantSnapshot<Value>(db: Database, tenant: TenantScope, work: (trx: DatabaseTransaction) => Promise<Value>): Promise<Value> {
  return db.transaction().setIsolationLevel("repeatable read").setAccessMode("read only").execute(async (trx) => {
    await sql`SELECT set_config('observation.producer', ${tenant.producer}, true), set_config('observation.namespace', ${tenant.namespace}, true)`.execute(trx);
    return work(trx);
  });
}
