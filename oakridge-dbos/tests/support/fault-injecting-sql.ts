import type { SqlExecutor, TransactionalSqlExecutor } from "../../src/storage/sql-executor";

/**
 * A test-only decorator of `TransactionalSqlExecutor` whose `transaction()`
 * rejects the next *N* calls with a synthetic connection error and passes
 * everything through afterwards (spec §5.4). `query()` is never faulted: only
 * `decide_run` and the other repository methods that open their own
 * transaction are exercised by this fixture — a blip on a bare `query()` is
 * not the boundary §3.5 is about.
 */
export class FaultInjectingSqlExecutor implements TransactionalSqlExecutor {
  private remaining_failures = 0;
  private failures_injected_count = 0;

  constructor(private readonly inner: TransactionalSqlExecutor) {}

  /** The next `count` calls to `transaction()` reject before running the operation. */
  fail_next_transactions(count: number): void {
    this.remaining_failures = count;
  }

  /** How many calls were actually rejected — set once `fail_next_transactions` is armed, never before. */
  get failures_injected(): number {
    return this.failures_injected_count;
  }

  query<Row extends object>(statement: string, parameters: readonly unknown[]): Promise<readonly Row[]> {
    return this.inner.query<Row>(statement, parameters);
  }

  transaction<Value>(operation: (transaction: SqlExecutor) => Promise<Value>): Promise<Value> {
    if (this.remaining_failures > 0) {
      this.remaining_failures -= 1;
      this.failures_injected_count += 1;
      return Promise.reject(Object.assign(new Error("injected connection failure"), { code: "08006" }));
    }
    return this.inner.transaction(operation);
  }
}
