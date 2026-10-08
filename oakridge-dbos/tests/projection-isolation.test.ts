import { expect, test } from "bun:test";
import { selectInboxItems } from "../src/projections/inbox";
import { DEFAULT_INBOX_LIMIT, readInbox } from "../src/storage/projection-reader";
import type { RunId, ScopeId, ScopeInstanceRecord } from "../src/storage/schema-records";
import type { DefinitionBundle } from "../src/core-client/generated-contracts";
import type { SqlExecutor, TransactionalSqlExecutor } from "../src/storage/sql-executor";

const scope = { id: "scope-1", run_id: "run-1", scope_key: "scope", version: 2, is_terminal: false,
  local_state: { schema: "state", data: { kind: "enum", variant: "ready" } } } as unknown as ScopeInstanceRecord;
const source = { scopes: [{ key: "scope", commands: [{ key: "review", label: "Review", consequence: "Continue", available_in: ["ready"] }] }] } as unknown as DefinitionBundle;

test("damaged scope produces its own diagnostic while another run stays available", () => {
  const damaged = selectInboxItems({ ...scope, source: null, decision: null });
  const healthy = selectInboxItems({ ...scope, id: "scope-2" as ScopeId, run_id: "run-2" as RunId, source, decision: null });
  expect(damaged[0]?.kind).toBe("diagnostic");
  expect(healthy[0]?.kind).toBe("command");
});
test("inbox rebuilds from one committed database snapshot", async () => {
  const statements: string[] = [];
  const db: TransactionalSqlExecutor = {
    async query<Row extends object>(statement: string): Promise<readonly Row[]> {
      statements.push(statement);
      if (statement.includes("FROM authority.definition_bundle")) return [{ id: "bundle-2", source }] as unknown as Row[];
      return [{ ...scope, definition_bundle_id: "missing", decision: null }, { ...scope, id: "scope-2", run_id: "run-2", definition_bundle_id: "bundle-2", decision: null }] as unknown as Row[];
    },
    async transaction<Value>(operation: (tx: SqlExecutor) => Promise<Value>, isolation?: "read committed" | "repeatable read"): Promise<Value> {
      expect(isolation).toBe("repeatable read");
      return operation(this);
    },
  };
  const inbox = await readInbox(db);
  expect(inbox.items.map((item) => item.kind)).toEqual(["diagnostic", "command"]);
  expect(statements).toHaveLength(2);
});

test("inbox limits a run page and returns a usable cursor", async () => {
  const rows = Array.from({ length: DEFAULT_INBOX_LIMIT + 1 }, (_, index) => ({ ...scope,
    id: `scope-${String(index).padStart(3, "0")}`, definition_bundle_id: "missing", decision: null }));
  const db: TransactionalSqlExecutor = {
    async query<Row extends object>(statement: string, params?: readonly unknown[]): Promise<readonly Row[]> {
      if (statement.includes("FROM authority.definition_bundle")) return [];
      expect(statement).toContain("LIMIT $4");
      expect(params?.[0]).toBe("run-1");
      const after = params?.[2] as string | null;
      return rows.filter((row) => !after || row.id > after).slice(0, Number(params?.[3])) as unknown as Row[];
    },
    async transaction<Value>(operation: (tx: SqlExecutor) => Promise<Value>): Promise<Value> { return operation(this); },
  };
  const first = await readInbox(db, { run_id: "run-1" as RunId });
  expect(first.items).toHaveLength(DEFAULT_INBOX_LIMIT);
  expect(first.next_cursor).not.toBeNull();
  const second = await readInbox(db, { run_id: "run-1" as RunId, cursor: first.next_cursor ?? undefined });
  expect(second.items).toHaveLength(1);
});
