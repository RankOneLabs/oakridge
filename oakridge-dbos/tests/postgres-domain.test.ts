import { expect, test } from "bun:test";

import type { ProjectId, WorkflowDefinitionId, WorkflowRunId } from "../src/domain/primitives";
import { PostgresWorkflowRunRepository } from "../src/storage/postgres-domain";
import type { PersistWorkflowRunLaunch } from "../src/domain/runs";
import type { SqlExecutor, TransactionalSqlExecutor } from "../src/storage/sql-executor";

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
