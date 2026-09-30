import { expect, test } from "bun:test";

import type { ProjectId, WorkflowDefinitionId } from "../src/domain/primitives";
import type { WorkflowDefinition } from "../src/domain/workflow";
import { PostgresProjectRepository } from "../src/storage/postgres-projects";
import { PostgresWorkflowDefinitionRepository } from "../src/storage/postgres-workflow-definitions";
import type { SqlExecutor, TransactionalSqlExecutor } from "../src/storage/sql-executor";
import { loadDevFlowV15 } from "../src/seed/dev-flow-v15";
import { createDevFlowAdapterRegistry } from "../src/adapters/dev-flow";
import { createPromptBundle } from "../src/runtime/prompt-template";

class StubSql implements TransactionalSqlExecutor {
  readonly calls: Array<{ statement: string; parameters: readonly unknown[] }> = [];
  transaction_calls = 0;
  constructor(private readonly rows: readonly object[]) {}
  async query<Row extends object>(statement: string, parameters: readonly unknown[]): Promise<readonly Row[]> { this.calls.push({ statement, parameters }); return this.rows as readonly Row[]; }
  transaction<Value>(operation: (transaction: SqlExecutor) => Promise<Value>): Promise<Value> { this.transaction_calls += 1; return operation(this); }
}

test("project repository persists and decodes the public project model", async () => {
  const row = { id: "00000000-0000-4000-8000-000000000001", name: "Oakridge", repo_dir: "/code/oakridge", created_at: "2026-08-15T12:00:00Z", forge_repository: null, integration_branch: null };
  const sql = new StubSql([row]);
  const created = await new PostgresProjectRepository(sql).insert({ id: row.id as ProjectId, name: row.name, repo_dir: row.repo_dir, created_at: row.created_at, forge_repository: null, integration_branch: null });
  expect(created).toEqual({ ...row, id: row.id as ProjectId });
  expect(sql.calls[0]?.statement).toContain("INSERT INTO oakridge.project");
  // The forge identity is serialised before it is bound: `pg` renders a JS value
  // for a `::jsonb` parameter by its own rules, and only a string is guaranteed
  // to arrive as the JSON that was meant.
  expect(sql.calls[0]?.parameters).toEqual([row.id, row.name, row.repo_dir, row.created_at, "null", null]);
});

test("project repository updates the mutable project fields", async () => {
  const stored = { id: "00000000-0000-4000-8000-000000000001", name: "Old Scout", repo_dir: "/code/personal/scout", created_at: "2026-08-15T12:00:00Z", forge_repository: null, integration_branch: "trunk" };
  const updated = { name: "Scout", repo_dir: "/code/rol/scout", forge_repository: { provider: "github" as const, owner: "RankOneLabs", name: "scout" }, integration_branch: "main" };
  const persisted = { ...stored, ...updated };
  const sql = new StubSql([persisted]);
  expect(await new PostgresProjectRepository(sql).update(stored.id as ProjectId, updated)).toEqual({ ...persisted, id: stored.id as ProjectId });
  expect(sql.calls[0]?.parameters).toEqual([stored.id, updated.name, updated.repo_dir, JSON.stringify(updated.forge_repository), updated.integration_branch]);
});

test("workflow definition list passes explicit archival policy to SQL", async () => {
  const sql = new StubSql([]);
  await new PostgresWorkflowDefinitionRepository(sql, createDevFlowAdapterRegistry()).list(true);
  expect(sql.calls[0]?.parameters).toEqual([true]);
  expect(sql.calls[0]?.statement).toContain("$1::boolean OR NOT archived");
});

test("workflow definition archival updates the query column and stored domain document", async () => {
  const definition: WorkflowDefinition = { id: "00000000-0000-4000-8000-000000000002" as WorkflowDefinitionId, name: "flow", version: 1, graph: { stages: {}, edges: [] }, archived: true, created_at: "2026-08-15T12:00:00Z" };
  const sql = new StubSql([{ definition }]);
  const updated = await new PostgresWorkflowDefinitionRepository(sql, createDevFlowAdapterRegistry()).set_archived(definition.id, true);
  expect(updated?.archived).toBe(true);
  expect(sql.calls[0]?.statement).toContain("jsonb_set");
  expect(sql.calls[0]?.parameters).toEqual([definition.id, true]);
});

test("immutable reseeding ignores archive state and preserves the stored archive value", async () => {
  const stored: WorkflowDefinition = { id: "00000000-0000-4000-8000-000000000002" as WorkflowDefinitionId, name: "flow", version: 1, graph: { stages: {}, edges: [] }, archived: true, created_at: "2026-08-15T12:00:00Z" };
  const sql = new StubSql([{ definition: stored, hash: "empty", version: 1, matrix: [] }]);
  const result = await new PostgresWorkflowDefinitionRepository(sql, createDevFlowAdapterRegistry()).insert_immutable({ ...stored, archived: false }, { version: 1, hash: "empty", matrix: [] });
  expect(result.archived).toBe(true);
  expect(sql.transaction_calls).toBe(1);
  expect(sql.calls).toHaveLength(3);
  expect(sql.calls[0]?.statement).toContain("definition - 'archived' = EXCLUDED.definition - 'archived'");
});

test("definition registration runs prompt-body placeholder validation before storage", async () => {
  const loaded = await loadDevFlowV15();
  if (!loaded.ok) throw new Error(loaded.error.detail);
  const bundle = await createPromptBundle(loaded.value, { load: async (path) => path === "dev-flow/v15/build/build/initial_build.md" ? "{{MISSPELLED_SLOT}}" : "valid" });
  const sql = new StubSql([]);
  await expect(new PostgresWorkflowDefinitionRepository(sql, createDevFlowAdapterRegistry()).insert_immutable(loaded.value, bundle)).rejects.toThrow("unbound_placeholder");
  expect(sql.calls).toHaveLength(0);
});
