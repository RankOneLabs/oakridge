import { expect, test } from "bun:test";
import { selectInboxItems } from "../src/projections/inbox";
import { readInbox } from "../src/storage/projection-reader";
import type { RunId, ScopeInstanceRecord } from "../src/storage/schema-records";
import type { DefinitionBundle } from "../src/core-client/generated-contracts";
import type { SqlExecutor, TransactionalSqlExecutor } from "../src/storage/sql-executor";

const scope = { id: "scope-1", run_id: "run-1", scope_key: "scope", version: 2, is_terminal: false,
  local_state: { schema: "state", data: { kind: "enum", variant: "ready" } } } as unknown as ScopeInstanceRecord;
const source = { scopes: [{ key: "scope", commands: [{ key: "review", label: "Review", consequence: "Continue", available_in: ["ready"] }] }] } as unknown as DefinitionBundle;

test("damaged scope produces its own diagnostic while another run stays available", () => {
  const damaged = selectInboxItems({ ...scope, source: null, decision: null });
  const healthy = selectInboxItems({ ...scope, id: "scope-2", run_id: "run-2" as RunId, source, decision: null });
  expect(damaged[0]?.kind).toBe("diagnostic");
  expect(healthy[0]?.kind).toBe("command");
});
test("inbox rebuilds from one committed database snapshot", async () => {
  const statements: string[] = [];
  const db: TransactionalSqlExecutor = {
    async query<Row extends object>(statement: string): Promise<readonly Row[]> {
      statements.push(statement);
      return [{ ...scope, source: null, decision: null }, { ...scope, id: "scope-2", run_id: "run-2", source, decision: null }] as unknown as Row[];
    },
    async transaction<Value>(operation: (tx: SqlExecutor) => Promise<Value>, isolation?: "read committed" | "repeatable read"): Promise<Value> {
      expect(isolation).toBe("repeatable read");
      return operation(this);
    },
  };
  const inbox = await readInbox(db);
  expect(inbox.items.map((item) => item.kind)).toEqual(["diagnostic", "command"]);
  expect(statements).toHaveLength(1);
});
