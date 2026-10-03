import { expect, test } from "bun:test";

import type { ProjectId, WorkflowDefinitionId } from "../src/domain/primitives";
import type { StoredWorkflowDefinition } from "../src/domain/dev-flow-v15";
import { PostgresProjectRepository } from "../src/storage/postgres-projects";
import { PostgresWorkflowDefinitionRepository } from "../src/storage/postgres-workflow-definitions";
import type { SqlExecutor, TransactionalSqlExecutor } from "../src/storage/sql-executor";
import { loadDevFlowV15 } from "../src/seed/dev-flow-v15";
import { compileV15WorkflowDefinition } from "../src/compiler/compile-v15";
const source = await loadDevFlowV15();
if (!source.ok) throw new Error(source.error.detail);
const definition: StoredWorkflowDefinition = { id: "00000000-0000-4000-8000-000000000002" as WorkflowDefinitionId,
  name: source.value.key, version: source.value.version, definition: source.value, archived: false, created_at: "2026-08-15T12:00:00Z" };

class StubSql implements TransactionalSqlExecutor {
  readonly calls: Array<{ statement: string; parameters: readonly unknown[] }> = [];
  transaction_calls = 0;
  constructor(private readonly rows: readonly object[]) {}
  async query<Row extends object>(statement: string, parameters: readonly unknown[]): Promise<readonly Row[]> { this.calls.push({ statement, parameters }); return this.rows as readonly Row[]; }
  transaction<Value>(operation: (transaction: SqlExecutor) => Promise<Value>): Promise<Value> { this.transaction_calls += 1; return operation(this); }
}

test("stored workflow definition retains the canonical workers and decision trees", async () => {
  const sql = new StubSql([definition]);
  const stored = await new PostgresWorkflowDefinitionRepository(sql).find_by_id(definition.id);
  expect(stored).toEqual(definition);
});

test("stored legacy graph documents are rejected", async () => {
  const sql = new StubSql([{ ...definition, definition: { graph: { stages: {}, edges: [] } } }]);
  await expect(new PostgresWorkflowDefinitionRepository(sql).find_by_id(definition.id))
    .rejects.toThrow("stored workflow definition is invalid");
});

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
  await new PostgresWorkflowDefinitionRepository(sql).list(true);
  expect(sql.calls[0]?.parameters).toEqual([true]);
  expect(sql.calls[0]?.statement).toContain("$1::boolean OR NOT archived");
});

test("workflow definition archival changes registry metadata without rewriting the contract", async () => {
  const sql = new StubSql([{ ...definition, archived: true }]);
  const updated = await new PostgresWorkflowDefinitionRepository(sql).set_archived(definition.id, true);
  expect(updated?.archived).toBe(true);
  expect(sql.calls[0]?.statement).not.toContain("jsonb_set");
  expect(updated?.definition).toEqual(source.value);
});

test("definition registration validates prompt placeholders before storage", async () => {
  const compiled = await compileV15WorkflowDefinition(source.value, { load: async () => "valid" });
  if (!compiled.ok) throw new Error(compiled.error.detail);
  const sql = new StubSql([]);
  const entry = compiled.value.prompts.entries[0];
  if (!entry) throw new Error("fixture has no prompt");
  const invalid = { ...compiled.value.prompts, entries: compiled.value.prompts.entries.map((candidate) =>
    candidate.path === entry.path ? { ...candidate, content: "{{MISSPELLED_SLOT}}" } : candidate) };
  await expect(new PostgresWorkflowDefinitionRepository(sql).insert_v15_immutable(source.value, invalid))
    .rejects.toThrow("unbound_placeholder");
  expect(sql.calls).toHaveLength(0);
});
