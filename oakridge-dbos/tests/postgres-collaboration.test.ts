import { expect, test } from "bun:test";

import type { ArtifactId } from "../src/domain/primitives";
import { PostgresCollaborationRepository } from "../src/storage/postgres-policy";
import type { TransactionalSqlExecutor } from "../src/storage/sql-executor";

test("chain-scoped collaboration reads filter on artifact chain identity", async () => {
  const statements: string[] = [];
  const sql: TransactionalSqlExecutor = {
    query: async <Row>(statement: string) => { statements.push(statement); return [] as Row[]; },
    transaction: async (operation) => operation(sql),
  };
  const repository = new PostgresCollaborationRepository(sql);
  const chainId = "00000000-0000-4000-8000-000000000001" as ArtifactId;
  await repository.list_threads(chainId);
  await repository.list_review_items(chainId);
  expect(statements).toHaveLength(2);
  expect(statements.every((statement) => statement.includes("WHERE artifact_id = $1"))).toBe(true);
});
