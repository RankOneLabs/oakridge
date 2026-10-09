import { expect, test } from "bun:test";
import { resolve } from "node:path";
import type { DefinitionBundle } from "../src/core-client/generated-contracts";
import { advanceChildren } from "../src/runtime/advance-children";
import type { TransactionalSqlExecutor } from "../src/storage/sql-executor";
import { runtimeFixture } from "./development-runtime-fixture";
import { withDatabase } from "./effect-fixture";

interface LifecycleRead { readonly statement: string; readonly parameters: readonly unknown[] }
test("lifecycle sweeps batch seven children, isolate targeted runs, and recover only active runs", async () => withDatabase(async ({ db }) => {
  const original: DefinitionBundle = await Bun.file(resolve(import.meta.dir, "../../workflow-core/fixtures/bundles/children-7.json")).json();
  const bundle: DefinitionBundle = { ...original, scopes: original.scopes.map((scope) => ({ ...scope, entry_command: "begin" })) };
  const active = await runtimeFixture(db, bundle, {});
  const unrelated = await runtimeFixture(db, bundle, {});
  const finished = await runtimeFixture(db, bundle, {});
  const reads: LifecycleRead[] = [];
  const observed_db: TransactionalSqlExecutor = {
    query<Row extends object>(statement: string, parameters: readonly unknown[]) {
      reads.push({ statement, parameters });
      return db.query<Row>(statement, parameters);
    },
    transaction: db.transaction.bind(db),
  };
  try {
    await active.fact("begin");
    await finished.fact("begin");
    await finished.fact("cancel");
    await advanceChildren({ db: observed_db, core: active.core, mutations: active.mutations, run_ids: [active.run_id] });
    expect((await unrelated.scope()).local_state.data).toMatchObject({ variant: "ready" });
    expect(reads.filter((read) => read.statement.includes("authority.child_collection"))).toHaveLength(1);
    expect(reads).toHaveLength(4);
    expect(reads.slice(1).every((read) => JSON.stringify(read.parameters) === JSON.stringify([[active.run_id]]))).toBe(true);
    reads.length = 0;
    await advanceChildren({ db: observed_db, core: active.core, mutations: active.mutations });
    expect((await unrelated.scope()).local_state.data).toMatchObject({ variant: "waiting" });
    const scope_read = reads.find((read) => read.statement.startsWith("SELECT * FROM authority.scope_instance"));
    expect(scope_read?.parameters).toEqual([[active.run_id, unrelated.run_id].sort()]);
    expect(reads.filter((read) => read.statement.includes("authority.child_collection"))).toHaveLength(1);
  } finally { active.core.close(); unrelated.core.close(); finished.core.close(); }
}), 30_000);
