import { expect, test } from "bun:test";

import type { ArtifactId, ExecutionId, StageInstanceId, UnitId, WorkflowRunId } from "../src/domain/primitives";
import { PostgresArtifactRepository, PostgresArtifactRevisionRepository, PostgresExecutionProjectionRepository, PostgresStageInstanceRepository, PostgresWorkflowAttemptRepository } from "../src/storage/postgres-domain";
import type { SqlExecutor, TransactionalSqlExecutor } from "../src/storage/sql-executor";

class StubSql implements SqlExecutor {
  readonly calls: { statement: string; parameters: readonly unknown[] }[] = [];
  constructor(private readonly rows: readonly object[]) {}
  async query<Row extends object>(statement: string, parameters: readonly unknown[]): Promise<readonly Row[]> {
    this.calls.push({ statement, parameters });
    return this.rows as readonly Row[];
  }
}

class TransactionStubSql implements TransactionalSqlExecutor {
  readonly calls: { statement: string; parameters: readonly unknown[] }[] = [];
  constructor(private readonly results: readonly (readonly object[])[]) {}
  async query<Row extends object>(statement: string, parameters: readonly unknown[]): Promise<readonly Row[]> {
    this.calls.push({ statement, parameters });
    return (this.results[this.calls.length - 1] ?? []) as readonly Row[];
  }
  transaction<Value>(operation: (transaction: SqlExecutor) => Promise<Value>): Promise<Value> { return operation(this); }
}

test("artifact retry returns the existing identity when the payload hash matches", async () => {
  const artifactId = "ef2b47a4-d1bd-44ee-840a-e4f7b27570db" as ArtifactId;
  const sql = new StubSql([{ id: artifactId, emission_payload_hash: "same" }]);
  const repository = new PostgresArtifactRepository(sql);
  const result = await repository.insert_idempotent({
    id: artifactId,
    run_id: "0d9ac045-f7e4-48a0-9b86-bd7cd2cf5f93" as WorkflowRunId,
    stage_instance_id: "fe412d1f-f740-4036-a69b-e623906bb8f3" as StageInstanceId,
    execution_id: "execution-1",
    unit_id: "0",
    output_name: "result",
    artifact_type: "dev.build_result",
    body: { summary: "done" },
    emission_idempotency_key: "emit-1",
    emission_payload_hash: "same",
  });
  expect(result).toBe(artifactId);
  expect(sql.calls).toHaveLength(1);
});

test("artifact retry rejects a reused key with a different payload", async () => {
  const sql = new StubSql([{ id: "artifact-existing", emission_payload_hash: "old" }]);
  const repository = new PostgresArtifactRepository(sql);
  expect(repository.insert_idempotent({
    id: "artifact-new" as ArtifactId,
    run_id: "run" as WorkflowRunId,
    stage_instance_id: "stage" as StageInstanceId,
    execution_id: "execution-1",
    unit_id: "0",
    output_name: "result",
    artifact_type: "result",
    body: { summary: "changed" },
    emission_idempotency_key: "emit-1",
    emission_payload_hash: "new",
  })).rejects.toThrow("different payload");
});

test("artifact revision retry returns the current tip for an identical representation", async () => {
  const tip = { id: "revision-1", chain_id: "revision-1", run_id: "run", stage_instance_id: "stage", execution_id: "execution", unit_id: "0", output_name: "result", artifact_type: "dev.result", label: null, body: { done: true }, version: 1, parent_artifact_id: null, emission_payload_hash: "same", created_at: "2026-08-14T00:00:00Z" };
  const sql = new TransactionStubSql([[], [tip]]);
  const repository = new PostgresArtifactRevisionRepository(sql);
  const revision = await repository.emit_revision("unused" as ArtifactId, { run_id: "run" as WorkflowRunId, stage_instance_id: "stage" as StageInstanceId, execution_id: "execution" as ExecutionId, unit_id: "0" as UnitId, output_name: "result", artifact_type: "dev.result", label: null, body: { done: true }, idempotency_key: "emit-retry", payload_hash: "same" }, "2026-08-14T00:00:01Z");
  expect(revision.id).toBe("revision-1" as ArtifactId);
  expect(sql.calls).toHaveLength(2);
});

test("a changed representation inserts the next parent-linked revision", async () => {
  const tip = { id: "revision-1", chain_id: "revision-1", run_id: "run", stage_instance_id: "stage", execution_id: "execution", unit_id: "0", output_name: "result", artifact_type: "dev.result", label: null, body: { done: true }, version: 1, parent_artifact_id: null, emission_payload_hash: "old", created_at: "2026-08-14T00:00:00Z" };
  const inserted = { ...tip, id: "revision-2", body: { done: "better" }, version: 2, parent_artifact_id: "revision-1", emission_payload_hash: "new", created_at: "2026-08-14T00:00:01Z" };
  const sql = new TransactionStubSql([[], [tip], [inserted]]);
  const repository = new PostgresArtifactRevisionRepository(sql);
  const revision = await repository.emit_revision("revision-2" as ArtifactId, { run_id: "run" as WorkflowRunId, stage_instance_id: "stage" as StageInstanceId, execution_id: "execution" as ExecutionId, unit_id: "0" as UnitId, output_name: "result", artifact_type: "dev.result", label: null, body: { done: "better" }, idempotency_key: "emit-2", payload_hash: "new" }, "2026-08-14T00:00:01Z");
  expect(revision.parent_artifact_id).toBe("revision-1" as ArtifactId);
  expect(sql.calls[2]?.parameters.slice(9, 12)).toEqual([2, "revision-1", "emit-2"]);
});

test("stage finish decodes a finished Oakridge lifecycle", async () => {
  const sql = new StubSql([{
    id: "stage",
    run_id: "run",
    stage_key: "build",
    stage_type: "delegated_session",
    started_at: "2026-08-14T00:00:00Z",
    ended_at: "2026-08-14T01:00:00Z",
    outcome: { kind: "succeeded" },
  }]);
  const repository = new PostgresStageInstanceRepository(sql);
  const stage = await repository.finish("stage" as StageInstanceId, "2026-08-14T01:00:00Z", { kind: "succeeded" });
  expect(stage.lifecycle.kind).toBe("finished");
});

test("execution projection records only domain links and optional executor metadata", async () => {
  const sql = new StubSql([]);
  const repository = new PostgresExecutionProjectionRepository(sql);
  await repository.record({ execution_id: "execution" as ExecutionId, stage_instance_id: "stage" as StageInstanceId, unit_id: "web" as UnitId, executor_type: "delegated_session", resolved_config: {}, inputs: [], declared_outputs: [] }, "root:stage:build:unit:web", { repository_key: "web" });
  await repository.attach_external("execution" as ExecutionId, { kind: "kbbl_session", session_id: "session-1" });
  await repository.record_terminal("execution" as ExecutionId, { kind: "succeeded", metadata: {} });
  expect(sql.calls[0]?.statement).toContain("INSERT INTO oakridge.executor_projection");
  expect(sql.calls[1]?.statement).toContain("external_reference");
  expect(sql.calls[2]?.statement).toContain("terminal_observation");
  expect(sql.calls.some((call) => call.statement.includes("status"))).toBe(false);
});

test("workflow attempts persist DBOS fork lineage separately from the logical run", async () => {
  const sql = new StubSql([]);
  const repository = new PostgresWorkflowAttemptRepository(sql);
  await repository.insert({ root_workflow_id: "root-2", run_id: "run-1" as WorkflowRunId,
    forked_from_root_workflow_id: "root-1", created_at: "2026-08-14T01:00:00Z" });
  expect(sql.calls[0]?.statement).toContain("INSERT INTO oakridge.workflow_attempt");
  expect(sql.calls[0]?.parameters).toEqual(["root-2", "run-1", "root-1", "2026-08-14T01:00:00Z"]);
});
