import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { advanceChildren } from "../src/runtime/advance-children";
import type { CoreClient } from "../src/core-client/client";
import type { DefinitionBundle } from "../src/core-client/generated-contracts";
import type { MutationService } from "../src/storage/mutation-service";
import type { TransactionalSqlExecutor } from "../src/storage/sql-executor";

async function lifecycle(should_conflict: (attempt: number) => boolean) {
  const original: DefinitionBundle = await Bun.file(resolve(import.meta.dir, "../../workflow-core/fixtures/bundles/minimal.json")).json();
  const bundle = { ...original, scopes: original.scopes.map((scope) => ({ ...scope, entry_command: "begin" })) };
  const scope = { id: "scope", run_id: "run", parent_id: null, is_terminal: false, scope_key: "document",
    local_state: { schema: "position", data: { kind: "variant", variant: "ready", value: { schema: "unit", data: { kind: "record", fields: [], dictionary: [] } } } } };
  const db = { query: async (statement: string) => statement.includes("FROM authority.run r") ? [{ run_id: "run", source: bundle }]
    : statement.includes("FROM authority.scope_instance WHERE run_id") ? [scope] : [] } as unknown as TransactionalSqlExecutor;
  const core = { request: async () => ({ ok: true, value: { kind: "validated", value: { schema: "unit", data: { kind: "record", fields: [], dictionary: [] } } } }) } as unknown as CoreClient;
  let calls = 0;
  const mutations = { decide: async () => ({ ok: true, value: should_conflict(++calls) ? { kind: "Conflict", detail: "read set changed" } : { kind: "Committed" } }) } as unknown as MutationService;
  const failures = await advanceChildren({ db, core, mutations, run_ids: ["run" as import("../src/storage/schema-records").RunId] });
  return { failures, calls };
}

test("a conflicting lifecycle trigger retries and commits", async () => {
  expect(await lifecycle((attempt) => attempt === 1)).toEqual({ failures: [], calls: 2 });
});

test("exhausted lifecycle conflicts identify the scope and trigger in the run diagnostic", async () => {
  const result = await lifecycle(() => true);
  expect(result.calls).toBe(3);
  expect(result.failures).toMatchObject([{ scope_id: "scope", detail: expect.stringContaining("lifecycle trigger begin for scope scope: Conflict after 3 attempts") }]);
});
