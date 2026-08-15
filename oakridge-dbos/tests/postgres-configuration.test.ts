import { expect, test } from "bun:test";

import type { ProjectId, WorkflowDefinitionId } from "../src/domain/primitives";
import type { WorkflowDefinition } from "../src/domain/workflow";
import { PostgresProjectRepository } from "../src/storage/postgres-projects";
import { PostgresWorkflowDefinitionRepository } from "../src/storage/postgres-workflow-definitions";
import type { SqlExecutor } from "../src/storage/sql-executor";

class StubSql implements SqlExecutor {
  readonly calls: Array<{ statement: string; parameters: readonly unknown[] }> = [];
  constructor(private readonly rows: readonly object[]) {}
  async query<Row extends object>(statement: string, parameters: readonly unknown[]): Promise<readonly Row[]> { this.calls.push({ statement, parameters }); return this.rows as readonly Row[]; }
}

test("project repository persists and decodes the public project model", async () => {
  const row = { id: "00000000-0000-4000-8000-000000000001", name: "Oakridge", repo_dir: "/code/oakridge", created_at: "2026-08-15T12:00:00Z", forge_repository: null, base_branch: null };
  const sql = new StubSql([row]);
  const created = await new PostgresProjectRepository(sql).insert({ id: row.id as ProjectId, name: row.name, repo_dir: row.repo_dir, created_at: row.created_at, forge_repository: null, base_branch: null });
  expect(created).toEqual({ ...row, id: row.id as ProjectId });
  expect(sql.calls[0]?.statement).toContain("INSERT INTO oakridge.project");
  expect(sql.calls[0]?.parameters).toEqual([row.id, row.name, row.repo_dir, row.created_at, null, null]);
});

test("workflow definition list passes explicit archival policy to SQL", async () => {
  const sql = new StubSql([]);
  await new PostgresWorkflowDefinitionRepository(sql).list(true);
  expect(sql.calls[0]?.parameters).toEqual([true]);
  expect(sql.calls[0]?.statement).toContain("$1::boolean OR NOT archived");
});

test("workflow definition archival updates the query column and stored domain document", async () => {
  const definition: WorkflowDefinition = { id: "00000000-0000-4000-8000-000000000002" as WorkflowDefinitionId, name: "flow", version: 1, graph: { stages: {}, edges: [] }, archived: true, created_at: "2026-08-15T12:00:00Z" };
  const sql = new StubSql([{ definition }]);
  const updated = await new PostgresWorkflowDefinitionRepository(sql).set_archived(definition.id, true);
  expect(updated?.archived).toBe(true);
  expect(sql.calls[0]?.statement).toContain("jsonb_set");
  expect(sql.calls[0]?.parameters).toEqual([definition.id, true]);
});

test("immutable reseeding ignores archive state and preserves the stored archive value", async () => {
  const stored: WorkflowDefinition = { id: "00000000-0000-4000-8000-000000000002" as WorkflowDefinitionId, name: "flow", version: 1, graph: { stages: {}, edges: [] }, archived: true, created_at: "2026-08-15T12:00:00Z" };
  const sql = new StubSql([{ definition: stored }]);
  const result = await new PostgresWorkflowDefinitionRepository(sql).insert_immutable({ ...stored, archived: false });
  expect(result.archived).toBe(true);
  expect(sql.calls[0]?.statement).toContain("definition - 'archived' = EXCLUDED.definition - 'archived'");
});
