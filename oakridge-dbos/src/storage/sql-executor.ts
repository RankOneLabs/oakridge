import { Pool, type PoolClient } from "pg";

export interface SqlExecutor {
  query<Row extends object>(statement: string, parameters: readonly unknown[]): Promise<readonly Row[]>;
}

export interface TransactionalSqlExecutor extends SqlExecutor {
  transaction<Value>(operation: (transaction: SqlExecutor) => Promise<Value>): Promise<Value>;
}

interface BunSqlClient {
  unsafe<Row extends object>(statement: string, parameters?: readonly unknown[]): Promise<readonly Row[]>;
  begin<Value>(operation: (transaction: BunSqlClient) => Promise<Value>): Promise<Value>;
  close(): Promise<void>;
}

export class BunPostgresExecutor implements TransactionalSqlExecutor {
  private constructor(private readonly client: BunSqlClient, private readonly owns_client: boolean) {}

  static connect(database_url: string): BunPostgresExecutor {
    return new BunPostgresExecutor(new Bun.SQL(database_url) as unknown as BunSqlClient, true);
  }

  query<Row extends object>(statement: string, parameters: readonly unknown[]): Promise<readonly Row[]> {
    return this.client.unsafe<Row>(statement, parameters);
  }

  transaction<Value>(operation: (transaction: SqlExecutor) => Promise<Value>): Promise<Value> {
    return this.client.begin((transaction) => operation(new BunPostgresExecutor(transaction, false)));
  }

  async close(): Promise<void> {
    if (this.owns_client) await this.client.close();
  }
}

export class PgPostgresExecutor implements TransactionalSqlExecutor {
  private constructor(private readonly client: Pool | PoolClient, private readonly pool: Pool | null) {}

  static connect(database_url: string): PgPostgresExecutor {
    const pool = new Pool({ connectionString: database_url });
    return new PgPostgresExecutor(pool, pool);
  }

  async query<Row extends object>(statement: string, parameters: readonly unknown[]): Promise<readonly Row[]> {
    const result = await this.client.query<Row>(statement, [...parameters]);
    return result.rows;
  }

  async transaction<Value>(operation: (transaction: SqlExecutor) => Promise<Value>): Promise<Value> {
    if (!this.pool) throw new Error("nested PostgreSQL transactions are not supported");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await operation(new PgPostgresExecutor(client, null));
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (this.pool) await this.pool.end();
  }
}
