import { expect, test } from "bun:test";

import type { ArtifactId, ExecutionId, ProjectId, StageInstanceId, UnitId, WorkflowDefinitionId, WorkflowRunId } from "../src/domain/primitives";
import { PostgresArtifactRevisionRepository, PostgresCancellationTargetRepository, PostgresExecutionProjectionRepository, PostgresResumeArtifactRepository, PostgresStageInstanceRepository, PostgresWorkflowAttemptRepository, PostgresWorkflowRunRepository } from "../src/storage/postgres-domain";
import type { PersistWorkflowRunLaunch } from "../src/domain/runs";
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

const launch: PersistWorkflowRunLaunch = {
  run: {
    id: "00000000-0000-4000-8000-000000000001" as WorkflowRunId,
    workflow_definition_id: "00000000-0000-4000-8000-000000000002" as WorkflowDefinitionId,
    project_id: "00000000-0000-4000-8000-000000000003" as ProjectId,
    context: { workdir: "/workspace/oakridge" },
    root_workflow_id: "oakridge-run:00000000-0000-4000-8000-000000000001:attempt:initial",
    archived: false,
    created_at: "2026-08-15T12:00:00Z",
  },
  epic_profile: null,
  workflow_definition_version: 2,
  application_version: "pr2-test",
};

test("workflow run creation persists run, initial attempt, and deterministic launch command in one transaction", async () => {
  const sql = new TransactionStubSql([[], [{ archived: false, version: 2 }], [], [{ id: launch.run.project_id }], [], [], []]);
  const result = await new PostgresWorkflowRunRepository(sql).create_with_initial_attempt(launch);
  expect(result).toEqual({ ok: true, value: { kind: "created", run: launch.run, epic_profile: null } });
  expect(sql.calls.map((call) => call.statement)).toEqual([
    expect.stringContaining("pg_advisory_xact_lock"),
    expect.stringContaining("FROM oakridge.workflow_definition"),
    expect.stringContaining("FROM oakridge.workflow_run"),
    expect.stringContaining("FROM oakridge.project"),
    expect.stringContaining("INSERT INTO oakridge.workflow_run"),
    expect.stringContaining("INSERT INTO oakridge.workflow_attempt"),
    expect.stringContaining("INSERT INTO oakridge.command_outbox"),
  ]);
  // The launch enqueue must be idempotent like every other outbox command;
  // it previously lacked the ON CONFLICT and raised on a duplicate key.
  expect(sql.calls[6]?.statement).toContain("ON CONFLICT (idempotency_key) DO NOTHING");
  expect(sql.calls[4]?.parameters).toEqual([
    launch.run.id, launch.run.workflow_definition_id, launch.run.project_id, launch.run.context,
    false, launch.run.created_at,
  ]);
  expect(sql.calls[4]?.statement).not.toContain("root_workflow_id");
  expect(sql.calls[6]?.parameters).toEqual([
    `run:${launch.run.id}:launch:${launch.run.root_workflow_id}`,
    launch.run.root_workflow_id,
    expect.objectContaining({ kind: "launch_run", run_id: launch.run.id, workflow_definition_version: 2, application_version: "pr2-test" }),
    launch.run.created_at,
    "run_launch",
  ]);
});

test("workflow run creation atomically includes an optional Epic profile", async () => {
  const epic = {
    id: launch.run.id as unknown as import("../src/domain/epic").EpicWorkflowProfileId,
    workflow_run_id: launch.run.id,
    title: "DBOS replacement", slug: "dbos-replacement", lifecycle_state: "active" as const,
    final_merge_policy: "guarded" as const, base_branch: "epic/dbos-replacement", repositories: [], created_at: launch.run.created_at, updated_at: launch.run.created_at,
  };
  const sql = new TransactionStubSql([[], [{ archived: false, version: 2 }], [], [{ id: launch.run.project_id }], [], [], [], []]);
  const result = await new PostgresWorkflowRunRepository(sql).create_with_initial_attempt({ ...launch, epic_profile: epic });
  expect(result.ok && result.value.epic_profile).toEqual(epic);
  expect(sql.calls[5]?.statement).toContain("INSERT INTO oakridge.epic_workflow_profile");
  expect(sql.calls[5]?.parameters[6]).toBe(epic.base_branch);
  expect(sql.calls[5]?.parameters[7]).toBe(JSON.stringify(epic.repositories));
  expect(sql.calls[6]?.statement).toContain("INSERT INTO oakridge.workflow_attempt");
});

test("workflow run creation replays only when run, profile, attempt, and launch command are immutable matches", async () => {
  const existing = { ...launch.run, immutable_matches: true };
  const sql = new TransactionStubSql([[], [{ archived: false, version: 2 }], [existing], [{ exists: false }], [{ matches: true }], []]);
  const result = await new PostgresWorkflowRunRepository(sql).create_with_initial_attempt(launch);
  expect(result).toEqual({ ok: true, value: { kind: "replayed", run: launch.run, epic_profile: null } });
  expect(sql.calls.some((call) => call.statement.includes("INSERT INTO oakridge.workflow_run"))).toBe(false);
  expect(sql.calls[2]?.parameters).toEqual([
    launch.run.id, launch.run.workflow_definition_id, launch.run.project_id, launch.run.context,
    launch.run.root_workflow_id,
  ]);
});

test("a launch is identified by its request, not by the timestamp the server stamped on it", async () => {
  const existing = { ...launch.run, immutable_matches: true };
  const sql = new TransactionStubSql([[], [{ archived: false, version: 2 }], [existing], [{ exists: false }], [{ matches: true }], []]);
  // Two concurrent requests carrying one Idempotency-Key each stamp their own
  // `now()`; the loser must replay the winner's run rather than 409.
  const loser = { ...launch, run: { ...launch.run, created_at: "2026-08-15T12:00:09Z" } };
  const result = await new PostgresWorkflowRunRepository(sql).create_with_initial_attempt(loser);
  expect(result).toEqual({ ok: true, value: expect.objectContaining({ kind: "replayed" }) });
  expect(sql.calls[2]?.statement).not.toContain("run.created_at =");
  expect(sql.calls[2]?.parameters).not.toContain(loser.run.created_at);
});

test("the stored launch command is compared without the timestamp only the winner could have stamped", async () => {
  const existing = { ...launch.run, immutable_matches: true };
  const sql = new TransactionStubSql([[], [{ archived: false, version: 2 }], [existing], [{ exists: false }], [{ matches: true }], []]);
  await new PostgresWorkflowRunRepository(sql).create_with_initial_attempt(launch);
  const comparison = sql.calls.find((call) => call.statement.includes("FROM oakridge.command_outbox"));
  expect(comparison?.statement).toContain("payload - 'created_at' = $3::jsonb");
  expect(comparison?.parameters[2]).not.toHaveProperty("created_at");
});

test("an epic profile replays on its request fields, not on the timestamps it inherited", async () => {
  const sql = new TransactionStubSql([[], [{ archived: false, version: 2 }], [{ ...launch.run, immutable_matches: true }], [{ matches: true }], [{ matches: true }], []]);
  const profile = {
    id: launch.run.id as unknown as import("../src/domain/epic").EpicWorkflowProfileId,
    workflow_run_id: launch.run.id, title: "DBOS replacement", slug: "dbos-replacement",
    lifecycle_state: "active" as const, final_merge_policy: "guarded" as const, base_branch: "epic/dbos-replacement", repositories: [],
    created_at: "2026-08-15T12:00:09Z", updated_at: "2026-08-15T12:00:09Z",
  };
  await new PostgresWorkflowRunRepository(sql).create_with_initial_attempt({ ...launch, epic_profile: profile });
  const comparison = sql.calls.find((call) => call.statement.includes("FROM oakridge.epic_workflow_profile"));
  expect(comparison?.statement).not.toContain("created_at =");
  expect(comparison?.parameters).not.toContain(profile.created_at);
});

test("workflow run launch replay ignores mutable archive state", async () => {
  const existing = { ...launch.run, archived: true, immutable_matches: true };
  const sql = new TransactionStubSql([[], [{ archived: false, version: 2 }], [existing], [{ exists: false }], [{ matches: true }], []]);
  const result = await new PostgresWorkflowRunRepository(sql).create_with_initial_attempt(launch);
  expect(result).toEqual({ ok: true, value: { kind: "replayed", run: { ...launch.run, archived: true }, epic_profile: null } });
  expect(sql.calls[2]?.statement).not.toContain("run.archived =");
});

test("workflow run replay rejects conflicting immutable launch data", async () => {
  const sql = new TransactionStubSql([[], [{ archived: false, version: 2 }], [{ ...launch.run, immutable_matches: false }]]);
  const result = await new PostgresWorkflowRunRepository(sql).create_with_initial_attempt(launch);
  expect(result).toEqual({ ok: false, error: expect.objectContaining({ kind: "idempotency_conflict" }) });
  expect(sql.calls).toHaveLength(3);
});

test("workflow run creation rechecks archived definition state inside its transaction", async () => {
  const sql = new TransactionStubSql([[], [{ archived: true, version: 2 }], []]);
  const result = await new PostgresWorkflowRunRepository(sql).create_with_initial_attempt(launch);
  expect(result).toEqual({ ok: false, error: expect.objectContaining({ kind: "definition_archived" }) });
  expect(sql.calls).toHaveLength(3);
});

test("an archived definition still permits an exact replay of its existing run", async () => {
  const existing = { ...launch.run, immutable_matches: true };
  const sql = new TransactionStubSql([[], [{ archived: true, version: 2 }], [existing], [{ exists: false }], [{ matches: true }], []]);
  const result = await new PostgresWorkflowRunRepository(sql).create_with_initial_attempt(launch);
  expect(result).toEqual({ ok: true, value: { kind: "replayed", run: launch.run, epic_profile: null } });
});

test("workflow run archive reports updated, unchanged, and not found outcomes", async () => {
  const changed = await new PostgresWorkflowRunRepository(new TransactionStubSql([[{ archived: true, changed: true }]])).set_archived(launch.run.id, true);
  const unchanged = await new PostgresWorkflowRunRepository(new TransactionStubSql([[{ archived: true, changed: false }]])).set_archived(launch.run.id, true);
  const missing = await new PostgresWorkflowRunRepository(new TransactionStubSql([[]])).set_archived(launch.run.id, true);
  expect(changed.kind).toBe("updated");
  expect(unchanged.kind).toBe("unchanged");
  expect(missing.kind).toBe("not_found");
});

test("workflow run reads and lists logical launches through their initial attempts", async () => {
  const readSql = new TransactionStubSql([[launch.run]]);
  const found = await new PostgresWorkflowRunRepository(readSql).find_launch_by_id(launch.run.id);
  expect(found).toEqual(launch.run);
  expect(readSql.calls[0]?.statement).toContain("attempt.forked_from_root_workflow_id IS NULL");

  const listSql = new TransactionStubSql([[launch.run]]);
  const listed = await new PostgresWorkflowRunRepository(listSql).list({ archived: null, project_id: launch.run.project_id! });
  expect(listed).toEqual([launch.run]);
  expect(listSql.calls[0]?.parameters).toEqual([null, null, launch.run.project_id]);
});

test("terminal run deletion is idempotent at the storage boundary", async () => {
  const deleted = await new PostgresWorkflowRunRepository(new TransactionStubSql([
    [{ id: launch.run.id }], [{ active_attempts: "0", active_external: "0", pending_commands: "0" }], [], [],
  ])).delete_terminal(launch.run.id);
  const replayed = await new PostgresWorkflowRunRepository(new TransactionStubSql([[]])).delete_terminal(launch.run.id);
  expect(deleted).toEqual({ kind: "deleted", run_id: launch.run.id });
  expect(replayed).toEqual({ kind: "already_deleted", run_id: launch.run.id });
});

test("run deletion rejects active DBOS, external, and pending-command ownership", async () => {
  const blocked = async (row: { active_attempts: string; active_external: string; pending_commands: string }) =>
    new PostgresWorkflowRunRepository(new TransactionStubSql([[{ id: launch.run.id }], [row]])).delete_terminal(launch.run.id);
  expect((await blocked({ active_attempts: "0", active_external: "1", pending_commands: "0" })).kind).toBe("external_execution_conflict");
  expect((await blocked({ active_attempts: "1", active_external: "0", pending_commands: "0" })).kind).toBe("active_conflict");
  expect((await blocked({ active_attempts: "0", active_external: "0", pending_commands: "1" })).kind).toBe("cancellation_pending");
});

test("run launch commands are claimed with a database lease", async () => {
  const sql = new TransactionStubSql([[]]);
  await new PostgresWorkflowRunRepository(sql).claim_pending_launches("worker", "2026-08-15T00:00:00Z", "2026-08-15T00:00:30Z", 100);
  expect(sql.calls[0]?.statement).toContain("FOR UPDATE SKIP LOCKED");
  expect(sql.calls[0]?.statement).toContain("command_type = 'run_launch'");
  expect(sql.calls[0]?.parameters).toEqual(["worker", "2026-08-15T00:00:00Z", "2026-08-15T00:00:30Z", 100]);
});

test("artifact revision retry returns the current tip for an identical representation", async () => {
  const tip = { id: "revision-1", chain_id: "revision-1", run_id: "run", stage_instance_id: "stage", execution_id: "execution", unit_id: "0", output_name: "result", artifact_type: "dev.result", label: null, body: { done: true }, version: 1, parent_artifact_id: null, emission_payload_hash: "same", lifecycle_state: "current", superseded_by_artifact_id: null, withdrawn_actor: null, withdrawn_reason: null, withdrawn_at: null, released_at: null, created_at: "2026-08-14T00:00:00Z" };
  const sql = new TransactionStubSql([[], [{ ended_at: null }], [tip]]);
  const repository = new PostgresArtifactRevisionRepository(sql);
  const revision = await repository.emit_revision("unused" as ArtifactId, { run_id: "run" as WorkflowRunId, stage_instance_id: "stage" as StageInstanceId, execution_id: "execution" as ExecutionId, unit_id: "0" as UnitId, output_name: "result", artifact_type: "dev.result", label: null, body: { done: true }, idempotency_key: "emit-retry", payload_hash: "same" }, "2026-08-14T00:00:01Z", { target_workflow_id: "execution-workflow", release: { kind: "immediate" } });
  expect(revision.ok && revision.value.artifact.id).toBe("revision-1" as ArtifactId);
  expect(sql.calls).toHaveLength(3);
});

test("artifact revision rejects an idempotency key reused with another payload", async () => {
  const replay = { id: "revision-1", chain_id: "revision-1", run_id: "run", stage_instance_id: "stage", execution_id: "execution", unit_id: "0", output_name: "result", artifact_type: "dev.result", label: null, body: { done: true }, version: 1, parent_artifact_id: null, emission_payload_hash: "old", lifecycle_state: "current", superseded_by_artifact_id: null, withdrawn_actor: null, withdrawn_reason: null, withdrawn_at: null, released_at: null, created_at: "2026-08-14T00:00:00Z" };
  const repository = new PostgresArtifactRevisionRepository(new TransactionStubSql([[], [{ ended_at: null }], [replay]]));
  const result = await repository.emit_revision("unused" as ArtifactId, { run_id: "run" as WorkflowRunId, stage_instance_id: "stage" as StageInstanceId, execution_id: "execution" as ExecutionId, unit_id: "0" as UnitId, output_name: "result", artifact_type: "dev.result", label: null, body: { done: "changed" }, idempotency_key: "emit-1", payload_hash: "new" }, "2026-08-14T00:00:01Z", { target_workflow_id: "execution-workflow", release: { kind: "immediate" } });
  expect(result).toEqual({ ok: false, error: expect.objectContaining({ kind: "idempotency_conflict", artifact_id: "revision-1" }) });
});

test("artifact emission rejects a stage closed by durable cancellation", async () => {
  const sql = new TransactionStubSql([[], [{ ended_at: "2026-08-14T00:00:01Z" }]]);
  const repository = new PostgresArtifactRevisionRepository(sql);
  const result = await repository.emit_revision("unused" as ArtifactId, { run_id: "run" as WorkflowRunId, stage_instance_id: "stage" as StageInstanceId, execution_id: "execution" as ExecutionId, unit_id: "0" as UnitId, output_name: "result", artifact_type: "dev.result", label: null, body: {}, idempotency_key: "late", payload_hash: "late" }, "2026-08-14T00:00:02Z", { target_workflow_id: "execution-workflow", release: { kind: "immediate" } });
  expect(result).toEqual({ ok: false, error: expect.objectContaining({ kind: "execution_closed" }) });
  expect(sql.calls[1]?.statement).toContain("FOR SHARE");
});

test("attempt cancellation withdraws pending artifacts and returns exact active DBOS waits", async () => {
  const sql = new TransactionStubSql([
    [{ resource_key: "stage:execution:unit:result" }], [],
    [{ kind: "gate", workflow_id: "execution:gate:artifact:wait:artifact_approval", application_version: "v2" }, { kind: "handoff", workflow_id: "execution:handoff:artifact-2", application_version: "v1" }],
    [{ id: "artifact" }, { id: "artifact-2" }],
  ]);
  const waits = await new PostgresCancellationTargetRepository(sql).terminalize_pending_waits("root-1", "workflow_cancellation", "cancelled", "2026-08-14T00:00:00Z");
  // The version rides along so containment can tell a wait that will answer
  // from one stranded by a version bump, which it would otherwise await forever.
  expect(waits).toEqual([
    { kind: "gate", workflow_id: "execution:gate:artifact:wait:artifact_approval", application_version: "v2" },
    { kind: "handoff", workflow_id: "execution:handoff:artifact-2", application_version: "v1" },
  ]);
  expect(sql.calls[1]?.statement).toContain("pg_advisory_xact_lock");
  expect(sql.calls[2]?.statement).toContain("FROM oakridge.wait");
  expect(sql.calls[2]?.statement).toContain("artifact.lifecycle_state = 'current'");
  expect(sql.calls[3]?.statement).toContain("lifecycle_state = 'withdrawn'");
  expect(sql.calls[3]?.statement).toContain("lifecycle_updated_at");
  expect(sql.calls[3]?.statement).not.toContain("jsonb_array_elements");
});

test("a changed representation inserts the next parent-linked revision", async () => {
  const tip = { id: "revision-1", chain_id: "revision-1", run_id: "run", stage_instance_id: "stage", execution_id: "execution", unit_id: "0", output_name: "result", artifact_type: "dev.result", label: null, body: { done: true }, version: 1, parent_artifact_id: null, emission_payload_hash: "old", lifecycle_state: "current", superseded_by_artifact_id: null, withdrawn_actor: null, withdrawn_reason: null, withdrawn_at: null, released_at: null, created_at: "2026-08-14T00:00:00Z" };
  const inserted = { ...tip, id: "revision-2", body: { done: "better" }, version: 2, parent_artifact_id: "revision-1", emission_payload_hash: "new", created_at: "2026-08-14T00:00:01Z" };
  const sql = new TransactionStubSql([[], [{ ended_at: null }], [], [tip], [tip], [inserted], [], [], []]);
  const repository = new PostgresArtifactRevisionRepository(sql);
  const revision = await repository.emit_revision("revision-2" as ArtifactId, { run_id: "run" as WorkflowRunId, stage_instance_id: "stage" as StageInstanceId, execution_id: "execution" as ExecutionId, unit_id: "0" as UnitId, output_name: "result", artifact_type: "dev.result", label: null, body: { done: "better" }, idempotency_key: "emit-2", payload_hash: "new" }, "2026-08-14T00:00:01Z", { target_workflow_id: "execution-workflow", release: { kind: "immediate" } });
  expect(revision.ok && revision.value.artifact.parent_artifact_id).toBe("revision-1" as ArtifactId);
  expect(sql.calls[5]?.parameters.slice(9, 12)).toEqual([2, "revision-1", "emit-2"]);
  expect(sql.calls.filter((call) => call.statement.includes("command_outbox"))).toHaveLength(1);
});

test("resume artifacts decode nonempty lifecycle rows and exclude historical revisions", async () => {
  const sql = new StubSql([{ id: "revision-2", chain_id: "revision-1", run_id: "run", stage_instance_id: "stage", execution_id: "execution", unit_id: "0", output_name: "result", artifact_type: "dev.result", label: null, body: { done: true }, version: 2, parent_artifact_id: "revision-1", emission_payload_hash: "same", lifecycle_state: "released", superseded_by_artifact_id: null, withdrawn_actor: null, withdrawn_reason: null, withdrawn_at: null, released_at: "2026-08-14T00:00:02Z", created_at: "2026-08-14T00:00:01Z", stage_key: "build" }]);
  const artifacts = await new PostgresResumeArtifactRepository(sql).list_latest_for_stages("run" as WorkflowRunId, ["build"]);
  expect(artifacts).toEqual([expect.objectContaining({ id: "revision-2", stage_key: "build", lifecycle: { kind: "released", released_at: "2026-08-14T00:00:02Z" } })]);
  expect(sql.calls[0]?.statement).toContain("artifact.lifecycle_state IN ('current', 'released')");
});

test("an execution's released outputs are read from the artifact table, latest revision per output", async () => {
  const sql = new StubSql([{ id: "revision-2", chain_id: "revision-1", run_id: "run", stage_instance_id: "stage", execution_id: "stage:web", unit_id: "web", output_name: "build_result", artifact_type: "dev.build_result", label: null, body: { done: true }, version: 2, parent_artifact_id: "revision-1", emission_payload_hash: "same", lifecycle_state: "released", superseded_by_artifact_id: null, withdrawn_actor: null, withdrawn_reason: null, withdrawn_at: null, released_at: "2026-08-28T18:50:02Z", created_at: "2026-08-28T17:08:04Z" }]);
  const artifacts = await new PostgresResumeArtifactRepository(sql).list_released_for_execution("stage:web" as ExecutionId);
  expect(artifacts).toEqual([expect.objectContaining({ id: "revision-2", unit_id: "web", output_name: "build_result", lifecycle: { kind: "released", released_at: "2026-08-28T18:50:02Z" } })]);
  expect(sql.calls[0]?.statement).toContain("artifact.lifecycle_state = 'released'");
  expect(sql.calls[0]?.statement).toContain("DISTINCT ON (artifact.unit_id, artifact.output_name)");
  expect(sql.calls[0]?.parameters).toEqual(["stage:web"]);
});

test("an execution's last observation is read from its projection, absent until one lands", async () => {
  const observed = { kind: "failed", code: "executor_silent_timeout", detail: "quiet" };
  expect(await new PostgresExecutionProjectionRepository(new StubSql([{ terminal_observation: observed }])).find_terminal_observation("stage:web" as ExecutionId)).toEqual(observed as never);
  expect(await new PostgresExecutionProjectionRepository(new StubSql([{ terminal_observation: null }])).find_terminal_observation("stage:web" as ExecutionId)).toBeNull();
  expect(await new PostgresExecutionProjectionRepository(new StubSql([])).find_terminal_observation("stage:web" as ExecutionId)).toBeNull();
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
  await repository.record({ execution_id: "execution" as ExecutionId, stage_instance_id: "stage" as StageInstanceId, unit_id: "web" as UnitId, executor_type: "delegated_session", resolved_config: {}, inputs: [], declared_outputs: [], expected_artifacts: [] }, "root:stage:build:unit:web", { repository_key: "web" });
  await repository.attach_external("execution" as ExecutionId, { kind: "kbbl_session", session_id: "session-1" });
  await repository.record_terminal("execution" as ExecutionId, { kind: "succeeded", metadata: {} });
  expect(sql.calls[0]?.statement).toContain("INSERT INTO oakridge.executor_projection");
  expect(sql.calls[1]?.statement).toContain("external_reference");
  expect(sql.calls[2]?.statement).toContain("terminal_observation");
  expect(sql.calls.some((call) => call.statement.includes("status"))).toBe(false);
});

test("execution projection serializes JSON arrays and objects before the PostgreSQL boundary", async () => {
  const sql = new StubSql([]);
  const repository = new PostgresExecutionProjectionRepository(sql);
  const inputs = [{ artifact_id: "artifact-1" as ArtifactId, artifact_type: "dev.spec_analysis", output_name: "spec_analysis", unit_id: "0" as UnitId, body: { findings: [] } }];
  await repository.record({
    execution_id: "execution" as ExecutionId,
    stage_instance_id: "stage" as StageInstanceId,
    unit_id: "0" as UnitId,
    executor_type: "delegated_session",
    resolved_config: {},
    inputs,
    declared_outputs: [], expected_artifacts: [],
  }, "root:stage:plan_writer:unit:0", { repository_key: "web" });

  expect(sql.calls[0]?.parameters[5]).toBe(JSON.stringify({ repository_key: "web" }));
  expect(sql.calls[0]?.parameters[6]).toBe(JSON.stringify(inputs));
});

test("workflow attempts persist DBOS fork lineage separately from the logical run", async () => {
  const sql = new StubSql([]);
  const repository = new PostgresWorkflowAttemptRepository(sql);
  await repository.insert({ root_workflow_id: "root-2", run_id: "run-1" as WorkflowRunId,
    forked_from_root_workflow_id: "root-1", created_at: "2026-08-14T01:00:00Z" });
  expect(sql.calls[0]?.statement).toContain("INSERT INTO oakridge.workflow_attempt");
  expect(sql.calls[0]?.parameters).toEqual(["root-2", "run-1", "root-1", "2026-08-14T01:00:00Z"]);
});

// A unit relaunched onto a revised input is a later attempt of the same
// execution. Its output supersedes what the earlier attempt released, where the
// earlier attempt's own re-emission is refused.
const releasedByFirstAttempt = { id: "revision-1", chain_id: "revision-1", run_id: "run", stage_instance_id: "stage", execution_id: "execution", unit_id: "0", output_name: "result", artifact_type: "dev.result", label: null, body: { done: true }, version: 1, parent_artifact_id: null, emission_payload_hash: "old", lifecycle_state: "released", superseded_by_artifact_id: null, withdrawn_actor: null, withdrawn_reason: null, withdrawn_at: null, released_at: "2026-08-14T00:00:00Z", created_at: "2026-08-14T00:00:00Z", attempt_workflow_id: "attempt-1" };
const emitAgain = (sql: TransactionStubSql, attempt: string) => new PostgresArtifactRevisionRepository(sql).emit_revision("revision-2" as ArtifactId,
  { run_id: "run" as WorkflowRunId, stage_instance_id: "stage" as StageInstanceId, execution_id: "execution" as ExecutionId, unit_id: "0" as UnitId, output_name: "result", artifact_type: "dev.result", label: null, body: { done: "again" }, idempotency_key: "emit-2", payload_hash: "new" },
  "2026-08-14T00:00:01Z", { target_workflow_id: attempt, release: { kind: "immediate" } });

test("a later attempt supersedes the artifact an earlier attempt released", async () => {
  const inserted = { ...releasedByFirstAttempt, id: "revision-2", version: 2, parent_artifact_id: "revision-1", emission_payload_hash: "new", lifecycle_state: "current", released_at: null, attempt_workflow_id: "attempt-2" };
  const sql = new TransactionStubSql([[], [{ ended_at: null }], [], [releasedByFirstAttempt], [releasedByFirstAttempt], [inserted]]);
  const result = await emitAgain(sql, "attempt-2");
  expect(result).toEqual({ ok: true, value: expect.objectContaining({ kind: "emitted", superseded_artifact_id: "revision-1" }) });
  const supersede = sql.calls.find((call) => call.statement.includes("lifecycle_state = 'superseded'"));
  expect(supersede?.statement).toContain("IN ('current', 'released')");
  expect(supersede?.parameters).toEqual(["revision-1", "revision-2", "2026-08-14T00:00:01Z"]);
  expect(sql.calls[5]?.parameters).toContain("attempt-2");
});

test("the attempt that released an artifact cannot revise it", async () => {
  const sql = new TransactionStubSql([[], [{ ended_at: null }], [], [releasedByFirstAttempt]]);
  const result = await emitAgain(sql, "attempt-1");
  expect(result).toEqual({ ok: false, error: expect.objectContaining({ kind: "release_conflict", artifact_id: "revision-1" }) });
});

test("a released artifact from before attempts were recorded stays final", async () => {
  const sql = new TransactionStubSql([[], [{ ended_at: null }], [], [{ ...releasedByFirstAttempt, attempt_workflow_id: null }]]);
  const result = await emitAgain(sql, "attempt-2");
  expect(result).toEqual({ ok: false, error: expect.objectContaining({ kind: "release_conflict" }) });
});
