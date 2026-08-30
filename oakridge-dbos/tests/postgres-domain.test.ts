import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import type { ProjectId, WorkflowDefinitionId, WorkflowRunId } from "../src/domain/primitives";
import { runRecordWorkflowId } from "../src/domain/workflow-ids";
import { PostgresWorkflowRunRepository } from "../src/storage/postgres-domain";
import type { PersistWorkflowRunLaunch } from "../src/domain/runs";
import { applyMigrations } from "../src/storage/migrate";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import type { SqlExecutor, TransactionalSqlExecutor } from "../src/storage/sql-executor";
import { findTestDatabaseUrl } from "./support/durable-database";
import { ensureDbosSystemSchema } from "./support/dbos-system-schema";

const databaseUrl = await findTestDatabaseUrl();
const sql = databaseUrl ? PgPostgresExecutor.connect(databaseUrl) : null;
if (sql) await applyMigrations(sql);
if (sql && databaseUrl) await ensureDbosSystemSchema(databaseUrl);
afterAll(async () => { await sql?.close(); });

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
    archived: false,
    created_at: "2026-08-15T12:00:00Z",
  },
  epic_profile: null,
  workflow_definition_version: 2,
};
const launchedRootWorkflowId = runRecordWorkflowId(launch.run.id);

test("workflow run creation persists the run row in one transaction, with no legacy attempt or command", async () => {
  const sql = new TransactionStubSql([[], [{ archived: false, version: 2 }], [], [{ id: launch.run.project_id }], []]);
  const result = await new PostgresWorkflowRunRepository(sql).create_run(launch);
  expect(result).toEqual({ ok: true, value: { kind: "created", run: { ...launch.run, root_workflow_id: launchedRootWorkflowId }, epic_profile: null } });
  expect(sql.calls.map((call) => call.statement)).toEqual([
    expect.stringContaining("pg_advisory_xact_lock"),
    expect.stringContaining("FROM oakridge.workflow_definition"),
    expect.stringContaining("FROM oakridge.workflow_run"),
    expect.stringContaining("FROM oakridge.project"),
    expect.stringContaining("INSERT INTO oakridge.workflow_run"),
  ]);
  expect(sql.calls[4]?.parameters).toEqual([
    launch.run.id, launch.run.workflow_definition_id, launch.run.project_id, launch.run.context,
    false, launch.run.created_at,
  ]);
  expect(sql.calls[4]?.statement).not.toContain("root_workflow_id");
  // The launch outbox and its initial attempt are gone (migration 0019): no
  // statement in this transaction may still reach for either table.
  expect(sql.calls.every((call) => !call.statement.includes("workflow_attempt") && !call.statement.includes("command_outbox"))).toBe(true);
});

test("workflow run creation atomically includes an optional Epic profile", async () => {
  const epic = {
    id: launch.run.id as unknown as import("../src/domain/epic").EpicWorkflowProfileId,
    workflow_run_id: launch.run.id,
    title: "DBOS replacement", slug: "dbos-replacement", lifecycle_state: "active" as const,
    final_merge_policy: "guarded" as const, base_branch: "epic/dbos-replacement", repositories: [], created_at: launch.run.created_at, updated_at: launch.run.created_at,
  };
  const sql = new TransactionStubSql([[], [{ archived: false, version: 2 }], [], [{ id: launch.run.project_id }], [], []]);
  const result = await new PostgresWorkflowRunRepository(sql).create_run({ ...launch, epic_profile: epic });
  expect(result.ok && result.value.epic_profile).toEqual(epic);
  expect(sql.calls[5]?.statement).toContain("INSERT INTO oakridge.epic_workflow_profile");
  expect(sql.calls[5]?.parameters[6]).toBe(epic.base_branch);
  expect(sql.calls[5]?.parameters[7]).toBe(JSON.stringify(epic.repositories));
});

test("workflow run creation replays only when the run and its epic profile are immutable matches", async () => {
  const existing = { ...launch.run, immutable_matches: true };
  const sql = new TransactionStubSql([[], [{ archived: false, version: 2 }], [existing], [{ exists: false }], []]);
  const result = await new PostgresWorkflowRunRepository(sql).create_run(launch);
  expect(result).toEqual({ ok: true, value: { kind: "replayed", run: { ...launch.run, root_workflow_id: launchedRootWorkflowId }, epic_profile: null } });
  expect(sql.calls.some((call) => call.statement.includes("INSERT INTO oakridge.workflow_run"))).toBe(false);
  expect(sql.calls[2]?.parameters).toEqual([
    launch.run.id, launch.run.workflow_definition_id, launch.run.project_id, launch.run.context,
  ]);
});

test("a launch is identified by its request, not by the timestamp the server stamped on it", async () => {
  const existing = { ...launch.run, immutable_matches: true };
  const sql = new TransactionStubSql([[], [{ archived: false, version: 2 }], [existing], [{ exists: false }], []]);
  // Two concurrent requests carrying one Idempotency-Key each stamp their own
  // `now()`; the loser must replay the winner's run rather than 409.
  const loser = { ...launch, run: { ...launch.run, created_at: "2026-08-15T12:00:09Z" } };
  const result = await new PostgresWorkflowRunRepository(sql).create_run(loser);
  expect(result).toEqual({ ok: true, value: expect.objectContaining({ kind: "replayed" }) });
  expect(sql.calls[2]?.statement).not.toContain("run.created_at =");
  expect(sql.calls[2]?.parameters).not.toContain(loser.run.created_at);
});

test("an epic profile replays on its request fields, not on the timestamps it inherited", async () => {
  const sql = new TransactionStubSql([[], [{ archived: false, version: 2 }], [{ ...launch.run, immutable_matches: true }], [{ matches: true }], []]);
  const profile = {
    id: launch.run.id as unknown as import("../src/domain/epic").EpicWorkflowProfileId,
    workflow_run_id: launch.run.id, title: "DBOS replacement", slug: "dbos-replacement",
    lifecycle_state: "active" as const, final_merge_policy: "guarded" as const, base_branch: "epic/dbos-replacement", repositories: [],
    created_at: "2026-08-15T12:00:09Z", updated_at: "2026-08-15T12:00:09Z",
  };
  await new PostgresWorkflowRunRepository(sql).create_run({ ...launch, epic_profile: profile });
  const comparison = sql.calls.find((call) => call.statement.includes("FROM oakridge.epic_workflow_profile"));
  expect(comparison?.statement).not.toContain("created_at =");
  expect(comparison?.parameters).not.toContain(profile.created_at);
});

test("workflow run launch replay ignores mutable archive state", async () => {
  const existing = { ...launch.run, archived: true, immutable_matches: true };
  const sql = new TransactionStubSql([[], [{ archived: false, version: 2 }], [existing], [{ exists: false }], []]);
  const result = await new PostgresWorkflowRunRepository(sql).create_run(launch);
  expect(result).toEqual({ ok: true, value: { kind: "replayed", run: { ...launch.run, archived: true, root_workflow_id: launchedRootWorkflowId }, epic_profile: null } });
  expect(sql.calls[2]?.statement).not.toContain("run.archived =");
});

test("workflow run replay rejects conflicting immutable launch data", async () => {
  const sql = new TransactionStubSql([[], [{ archived: false, version: 2 }], [{ ...launch.run, immutable_matches: false }]]);
  const result = await new PostgresWorkflowRunRepository(sql).create_run(launch);
  expect(result).toEqual({ ok: false, error: expect.objectContaining({ kind: "idempotency_conflict" }) });
  expect(sql.calls).toHaveLength(3);
});

test("workflow run creation rechecks archived definition state inside its transaction", async () => {
  const sql = new TransactionStubSql([[], [{ archived: true, version: 2 }], []]);
  const result = await new PostgresWorkflowRunRepository(sql).create_run(launch);
  expect(result).toEqual({ ok: false, error: expect.objectContaining({ kind: "definition_archived" }) });
  expect(sql.calls).toHaveLength(3);
});

test("an archived definition still permits an exact replay of its existing run", async () => {
  const existing = { ...launch.run, immutable_matches: true };
  const sql = new TransactionStubSql([[], [{ archived: true, version: 2 }], [existing], [{ exists: false }], []]);
  const result = await new PostgresWorkflowRunRepository(sql).create_run(launch);
  expect(result).toEqual({ ok: true, value: { kind: "replayed", run: { ...launch.run, root_workflow_id: launchedRootWorkflowId }, epic_profile: null } });
});

test("workflow run archive reports updated, unchanged, and not found outcomes", async () => {
  const changed = await new PostgresWorkflowRunRepository(new TransactionStubSql([[{ archived: true, changed: true }]])).set_archived(launch.run.id, true);
  const unchanged = await new PostgresWorkflowRunRepository(new TransactionStubSql([[{ archived: true, changed: false }]])).set_archived(launch.run.id, true);
  const missing = await new PostgresWorkflowRunRepository(new TransactionStubSql([[]])).set_archived(launch.run.id, true);
  expect(changed.kind).toBe("updated");
  expect(unchanged.kind).toBe("unchanged");
  expect(missing.kind).toBe("not_found");
});

test("workflow run reads and lists logical launches, with the root workflow id derived rather than joined", async () => {
  const readSql = new TransactionStubSql([[launch.run]]);
  const found = await new PostgresWorkflowRunRepository(readSql).find_launch_by_id(launch.run.id);
  expect(found).toEqual({ ...launch.run, root_workflow_id: launchedRootWorkflowId });
  expect(readSql.calls[0]?.statement).not.toContain("workflow_attempt");

  const listSql = new TransactionStubSql([[launch.run]]);
  const listed = await new PostgresWorkflowRunRepository(listSql).list({ archived: null, project_id: launch.run.project_id! });
  expect(listed).toEqual([{ ...launch.run, root_workflow_id: launchedRootWorkflowId }]);
  expect(listSql.calls[0]?.parameters).toEqual([null, null, launch.run.project_id]);
  expect(listSql.calls[0]?.statement).not.toContain("workflow_attempt");
});

/**
 * `list_unstarted_runs` is the launch sweep's read model now that there is no
 * outbox table: an `active` run with no `dbos.workflow_status` row for its
 * derived `v2-run:<id>` is the durable "not started yet" signal.
 */
test("an active run with no DBOS workflow row is listed as unstarted; one with a row is not; a completed run is not", async () => {
  if (!sql) { console.warn("postgres-domain PostgreSQL test SKIPPED: no PostgreSQL reachable"); return; }
  const definitionId = randomUUID() as WorkflowDefinitionId;
  const now = new Date().toISOString();
  await sql.query(`INSERT INTO oakridge.workflow_definition (id, name, version, definition, archived, created_at) VALUES ($1,$2,1,'{"graph":{"stages":{},"edges":[]}}'::jsonb,false,$3::timestamptz)`,
    [definitionId, `list-unstarted-${definitionId}`, now]);

  const unstartedRunId = randomUUID() as WorkflowRunId;
  const startedRunId = randomUUID() as WorkflowRunId;
  const completedRunId = randomUUID() as WorkflowRunId;
  await sql.query(`INSERT INTO oakridge.workflow_run (id, workflow_definition_id, context, created_at) VALUES ($1,$2,'{}'::jsonb,$3::timestamptz)`, [unstartedRunId, definitionId, now]);
  await sql.query(`INSERT INTO oakridge.workflow_run (id, workflow_definition_id, context, created_at) VALUES ($1,$2,'{}'::jsonb,$3::timestamptz)`, [startedRunId, definitionId, now]);
  await sql.query(`INSERT INTO oakridge.workflow_run (id, workflow_definition_id, context, created_at, state, outcome, ended_at) VALUES ($1,$2,'{}'::jsonb,$3::timestamptz,'succeeded','{"kind":"succeeded"}'::jsonb,$3::timestamptz)`,
    [completedRunId, definitionId, now]);
  await sql.query(`INSERT INTO dbos.workflow_status (workflow_uuid, status, name, application_version, executor_id, created_at, updated_at)
    VALUES ($1,'PENDING','oakridgeV2RunWorkflow','test','test-executor', (extract(epoch FROM now())*1000)::bigint, (extract(epoch FROM now())*1000)::bigint)`,
    [runRecordWorkflowId(startedRunId)]);

  // A large limit, not the sweep's real page size: this database accumulates
  // rows across the whole test suite's history, and `ORDER BY created_at`
  // would otherwise sort this test's freshly-created rows behind an
  // unbounded backlog of older ones and truncate them out of a small page.
  const repository = new PostgresWorkflowRunRepository(sql);
  const unstarted = await repository.list_unstarted_runs(100_000);
  const runIds = unstarted.map((run) => run.run_id);
  expect(runIds).toContain(unstartedRunId);
  expect(runIds).not.toContain(startedRunId);
  expect(runIds).not.toContain(completedRunId);
  expect(unstarted.find((run) => run.run_id === unstartedRunId)?.workflow_id).toBe(runRecordWorkflowId(unstartedRunId));
});
