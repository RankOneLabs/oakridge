import { expect, test } from "bun:test";

import type { ArtifactId, ExecutionId, StageInstanceId, UnitId, WorkflowRunId } from "../src/domain/primitives";
import { PostgresArtifactRevisionRepository, PostgresExecutionProjectionRepository, PostgresResumeArtifactRepository, PostgresStageInstanceRepository, PostgresWorkflowAttemptRepository } from "../src/storage/postgres-domain";
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

test("artifact revision retry returns the current tip for an identical representation", async () => {
  const tip = { id: "revision-1", chain_id: "revision-1", run_id: "run", stage_instance_id: "stage", execution_id: "execution", unit_id: "0", output_name: "result", artifact_type: "dev.result", label: null, body: { done: true }, version: 1, parent_artifact_id: null, emission_payload_hash: "same", lifecycle_state: "current", superseded_by_artifact_id: null, withdrawn_actor: null, withdrawn_reason: null, withdrawn_at: null, released_at: null, created_at: "2026-08-14T00:00:00Z" };
  const sql = new TransactionStubSql([[], [tip]]);
  const repository = new PostgresArtifactRevisionRepository(sql);
  const revision = await repository.emit_revision("unused" as ArtifactId, { run_id: "run" as WorkflowRunId, stage_instance_id: "stage" as StageInstanceId, execution_id: "execution" as ExecutionId, unit_id: "0" as UnitId, output_name: "result", artifact_type: "dev.result", label: null, body: { done: true }, idempotency_key: "emit-retry", payload_hash: "same" }, "2026-08-14T00:00:01Z", { target_workflow_id: "execution-workflow", release: { kind: "immediate" } });
  expect(revision.ok && revision.value.artifact.id).toBe("revision-1" as ArtifactId);
  expect(sql.calls).toHaveLength(2);
});

test("artifact revision rejects an idempotency key reused with another payload", async () => {
  const replay = { id: "revision-1", chain_id: "revision-1", run_id: "run", stage_instance_id: "stage", execution_id: "execution", unit_id: "0", output_name: "result", artifact_type: "dev.result", label: null, body: { done: true }, version: 1, parent_artifact_id: null, emission_payload_hash: "old", lifecycle_state: "current", superseded_by_artifact_id: null, withdrawn_actor: null, withdrawn_reason: null, withdrawn_at: null, released_at: null, created_at: "2026-08-14T00:00:00Z" };
  const repository = new PostgresArtifactRevisionRepository(new TransactionStubSql([[], [replay]]));
  const result = await repository.emit_revision("unused" as ArtifactId, { run_id: "run" as WorkflowRunId, stage_instance_id: "stage" as StageInstanceId, execution_id: "execution" as ExecutionId, unit_id: "0" as UnitId, output_name: "result", artifact_type: "dev.result", label: null, body: { done: "changed" }, idempotency_key: "emit-1", payload_hash: "new" }, "2026-08-14T00:00:01Z", { target_workflow_id: "execution-workflow", release: { kind: "immediate" } });
  expect(result).toEqual({ ok: false, error: expect.objectContaining({ kind: "idempotency_conflict", artifact_id: "revision-1" }) });
});

test("a changed representation inserts the next parent-linked revision", async () => {
  const tip = { id: "revision-1", chain_id: "revision-1", run_id: "run", stage_instance_id: "stage", execution_id: "execution", unit_id: "0", output_name: "result", artifact_type: "dev.result", label: null, body: { done: true }, version: 1, parent_artifact_id: null, emission_payload_hash: "old", lifecycle_state: "current", superseded_by_artifact_id: null, withdrawn_actor: null, withdrawn_reason: null, withdrawn_at: null, released_at: null, created_at: "2026-08-14T00:00:00Z" };
  const inserted = { ...tip, id: "revision-2", body: { done: "better" }, version: 2, parent_artifact_id: "revision-1", emission_payload_hash: "new", created_at: "2026-08-14T00:00:01Z" };
  const sql = new TransactionStubSql([[], [], [tip], [tip], [inserted], [], [], []]);
  const repository = new PostgresArtifactRevisionRepository(sql);
  const revision = await repository.emit_revision("revision-2" as ArtifactId, { run_id: "run" as WorkflowRunId, stage_instance_id: "stage" as StageInstanceId, execution_id: "execution" as ExecutionId, unit_id: "0" as UnitId, output_name: "result", artifact_type: "dev.result", label: null, body: { done: "better" }, idempotency_key: "emit-2", payload_hash: "new" }, "2026-08-14T00:00:01Z", { target_workflow_id: "execution-workflow", release: { kind: "immediate" } });
  expect(revision.ok && revision.value.artifact.parent_artifact_id).toBe("revision-1" as ArtifactId);
  expect(sql.calls[4]?.parameters.slice(9, 12)).toEqual([2, "revision-1", "emit-2"]);
  expect(sql.calls.filter((call) => call.statement.includes("command_outbox"))).toHaveLength(1);
});

test("resume artifacts decode nonempty lifecycle rows and exclude historical revisions", async () => {
  const sql = new StubSql([{ id: "revision-2", chain_id: "revision-1", run_id: "run", stage_instance_id: "stage", execution_id: "execution", unit_id: "0", output_name: "result", artifact_type: "dev.result", label: null, body: { done: true }, version: 2, parent_artifact_id: "revision-1", emission_payload_hash: "same", lifecycle_state: "released", superseded_by_artifact_id: null, withdrawn_actor: null, withdrawn_reason: null, withdrawn_at: null, released_at: "2026-08-14T00:00:02Z", created_at: "2026-08-14T00:00:01Z", stage_key: "build" }]);
  const artifacts = await new PostgresResumeArtifactRepository(sql).list_latest_for_stages("run" as WorkflowRunId, ["build"]);
  expect(artifacts).toEqual([expect.objectContaining({ id: "revision-2", stage_key: "build", lifecycle: { kind: "released", released_at: "2026-08-14T00:00:02Z" } })]);
  expect(sql.calls[0]?.statement).toContain("artifact.lifecycle_state IN ('current', 'released')");
});

test("artifact notification claims are leased and preserve per-workflow ordering", async () => {
  const sql = new StubSql([]);
  await new PostgresArtifactRevisionRepository(sql as unknown as TransactionalSqlExecutor).claim_pending_notifications("worker-1", "2026-08-14T00:00:00Z", "2026-08-14T00:00:30Z", 100);
  expect(sql.calls[0]?.statement).toContain("FOR UPDATE SKIP LOCKED");
  expect(sql.calls[0]?.statement).toContain("earlier.target_workflow_id = candidate.target_workflow_id");
  expect(sql.calls[0]?.parameters).toEqual(["worker-1", "2026-08-14T00:00:00Z", "2026-08-14T00:00:30Z", 100]);
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
