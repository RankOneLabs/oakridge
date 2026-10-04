import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { prepareV15StageFixture as prepare } from "./support/v15-stage-fixture";
import { materializeStageInStorage } from "../src/storage/materialize-stage";
import { PostgresRunRecordRepository } from "../src/storage/postgres-run-record-repository";
import { StageEventApplier } from "../src/storage/apply-stage-event";
import { PostgresRunRecordWriter } from "../src/storage/postgres-run-record";
import { dispatchProvisionExecution } from "../src/runtime/provision-execution";
import type { CohortId, ExecutionId, WorkflowRunId } from "../src/domain/primitives";
import type { GitCommandRunner } from "../src/domain/repository-provisioning";
const now = () => new Date().toISOString();

for (const failure_kind of ["not_a_git_repository", "missing_integration_branch", "base_branch_unavailable", "git_command_failed"] as const) {
  test(`provisioning records ${failure_kind} as a known failed cohort with its original evidence`, async () => {
    const fixture = await prepare();
    try {
      const opened = await materializeStageInStorage(fixture.sql, { stage_instance_id: fixture.stage_id, at: now() });
      if (!opened.ok || opened.value.kind !== "opened") throw new Error("stage did not open");
      const cohort_id = opened.value.cohort_ids[0]!;
      const git: GitCommandRunner = { async run(directory, args) {
        const should_fail = failure_kind === "not_a_git_repository" && args[0] === "rev-parse"
          || failure_kind === "missing_integration_branch" && args[0] === "fetch"
          || failure_kind === "base_branch_unavailable" && args[0] === "push"
          || failure_kind === "git_command_failed" && args[0] === "ls-remote";
        return should_fail ? { exit_code: 1, stdout: "", stderr: "controlled Git failure" } : fixture.git.run(directory, args);
      } };
      const ingress = new StageEventApplier({ sql: fixture.sql, writer: new PostgresRunRecordWriter(fixture.sql), now,
        dispatch_executions: async (ids) => { for (const id of ids) await dispatchProvisionExecution({ sql: fixture.sql, git, now,
          advance: (cohort) => ingress.advance(cohort, null) }, id); } });
      await ingress.advance(cohort_id, null);
      expect((await fixture.sql.query("SELECT state FROM oakridge.cohort WHERE id=$1", [cohort_id]))[0]).toEqual({ state: "failed" });
      expect((await fixture.sql.query<{ readonly operation_outcome: unknown }>("SELECT operation_outcome FROM oakridge.execution_intent WHERE cohort_id=$1", [cohort_id]))[0]?.operation_outcome)
        .toMatchObject({ kind: "failed", failure: { operation: "provision_repository_refs", cohort_id, repository_key: "oakridge", kind: failure_kind,
          detail: expect.any(String), evidence: { kind: failure_kind, repository_path: fixture.repository } } });
      expect(await fixture.sql.query("SELECT id FROM oakridge.session", [])).toEqual([]);
    } finally { await fixture.close(); }
  });
}

test("provisioning publishes mechanically with null session provenance and stable stage replay", async () => {
  const fixture = await prepare();
  try {
    const first = await materializeStageInStorage(fixture.sql, { stage_instance_id: fixture.stage_id, at: now() });
    expect(first.ok).toBe(true);
    if (!first.ok || first.value.kind !== "opened") throw new Error("stage did not open");
    expect(await materializeStageInStorage(fixture.sql, { stage_instance_id: fixture.stage_id, at: now() })).toEqual(first);
    const cohort_id = first.value.cohort_ids[0]!;
    const ingress = new StageEventApplier({ sql: fixture.sql,
      writer: new PostgresRunRecordWriter(fixture.sql), now,
      dispatch_executions: async (ids) => { for (const id of ids) {
        const dispatched = await dispatchProvisionExecution({ sql: fixture.sql, git: fixture.git, now,
          advance: (cohort) => ingress.advance(cohort, null) }, id);
        if (!dispatched.ok) throw new Error(dispatched.error.detail);
      } } });
    const result = await ingress.advance(cohort_id, null);
    expect(result.ok).toBe(true);
    expect((await fixture.sql.query<{ readonly state: string }>("SELECT state FROM oakridge.cohort WHERE id=$1", [cohort_id]))[0]?.state).toBe("complete");
    expect(await fixture.sql.query("SELECT id FROM oakridge.session", [])).toEqual([]);
    expect((await fixture.sql.query<{ readonly session_id: string | null }>("SELECT session_id FROM oakridge.artifact_provenance", []))[0]?.session_id).toBeNull();
    const intent = (await fixture.sql.query<{ readonly id: ExecutionId }>("SELECT id FROM oakridge.execution_intent", []))[0]!;
    expect((await dispatchProvisionExecution({ sql: fixture.sql, git: fixture.git, now,
      advance: (cohort) => ingress.advance(cohort, null) }, intent.id)).ok).toBe(true);
    expect((await fixture.sql.query<{ readonly count: string }>("SELECT count(*)::text FROM oakridge.artifact", []))[0]?.count).toBe("1");
  } finally { await fixture.close(); }
});

test("a provision operation lost after remote push retries without rewinding the existing branch or creating sessions", async () => {
  const fixture = await prepare();
  try {
    const opened = await materializeStageInStorage(fixture.sql, { stage_instance_id: fixture.stage_id, at: now() });
    if (!opened.ok || opened.value.kind !== "opened") throw new Error("stage did not open");
    const cohort_id = opened.value.cohort_ids[0]!;
    let should_crash = true;
    const git: GitCommandRunner = { async run(directory, args) {
      const result = await fixture.git.run(directory, args);
      if (should_crash && args[0] === "push" && result.exit_code === 0) { should_crash = false; throw new Error("lost operation after push"); }
      return result;
    } };
    const ingress = new StageEventApplier({ sql: fixture.sql,
      writer: new PostgresRunRecordWriter(fixture.sql), now,
      dispatch_executions: async (ids) => { for (const id of ids) await dispatchProvisionExecution({
        sql: fixture.sql, git, now, advance: (cohort) => ingress.advance(cohort, null) }, id); } });
    expect((await ingress.advance(cohort_id, null)).ok).toBe(true);
    const prior = await fixture.runGit(fixture.repository, ["ls-remote", "origin", "refs/heads/epic/b4"]);
    const version = Number((await fixture.sql.query<{ readonly version: string }>("SELECT durable_version::text AS version FROM oakridge.cohort WHERE id=$1", [cohort_id]))[0]!.version);
    expect((await ingress.advance(cohort_id, { id: randomUUID() as never, cohort_id, expected_version: version,
      request: { kind: "retry_provision" } })).ok).toBe(true);
    expect(await fixture.runGit(fixture.repository, ["ls-remote", "origin", "refs/heads/epic/b4"])).toBe(prior);
    expect(await fixture.sql.query("SELECT id FROM oakridge.session", [])).toEqual([]);
    expect((await fixture.sql.query<{ readonly state: string }>("SELECT state FROM oakridge.cohort WHERE id=$1", [cohort_id]))[0]?.state).toBe("complete");
  } finally { await fixture.close(); }
});

test("cancelling an uninitialized stage does not create its cohorts", async () => {
  const fixture = await prepare();
  try {
    await fixture.sql.query("UPDATE oakridge.stage_instance SET status='cancelled',ended_at=now() WHERE id=$1", [fixture.stage_id]);
    expect(await materializeStageInStorage(fixture.sql, { stage_instance_id: fixture.stage_id, at: now() })).toEqual({ ok: true, value: { kind: "stage_not_active", detail: "run or stage is stopped" } });
    expect(await fixture.sql.query<{ readonly id: CohortId }>("SELECT id FROM oakridge.cohort", [])).toEqual([]);
  } finally { await fixture.close(); }
});

test("invalid stage membership leaves initialization and all cohort rows untouched", async () => {
  const fixture = await prepare();
  try {
    await fixture.sql.query("UPDATE oakridge.workflow_run SET context=jsonb_set(context,'{repositories,0,key}','\"../collision\"'::jsonb) WHERE id=$1", [fixture.run_id]);
    expect(await materializeStageInStorage(fixture.sql, { stage_instance_id: fixture.stage_id, at: now() }))
      .toMatchObject({ ok: false, error: { kind: "invalid_mapping" } });
    expect((await fixture.sql.query("SELECT initialized_at FROM oakridge.stage_instance WHERE id=$1", [fixture.stage_id]))[0])
      .toEqual({ initialized_at: null });
    expect(await fixture.sql.query("SELECT id FROM oakridge.cohort", [])).toEqual([]);
  } finally { await fixture.close(); }
});


test("S13 cancellation racing roster opening leaves no work with execution authority", async () => {
  const fixture = await prepare();
  try {
    const writer = new PostgresRunRecordWriter(fixture.sql);
    const ingress = new StageEventApplier({ sql: fixture.sql, writer, now });
    const records = new PostgresRunRecordRepository(fixture.sql, writer, ingress);
    const [opened, cancelled] = await Promise.all([
      materializeStageInStorage(fixture.sql, { stage_instance_id: fixture.stage_id, at: now() }),
      records.cancel_run({ run_id: fixture.run_id as WorkflowRunId, actor: "operator", reason: "cancel roster race", cancelled_at: now() }),
    ]);
    expect(opened.ok).toBe(true);
    expect(cancelled.kind).toBe("cancelled");
    expect((await fixture.sql.query<{ readonly status: string }>("SELECT status FROM oakridge.workflow_run WHERE id=$1", [fixture.run_id]))[0]?.status).toBe("cancelled");
    const ids = await fixture.sql.query<{ readonly id: CohortId; readonly state: string }>("SELECT id,state FROM oakridge.cohort", []);
    for (const cohort of ids) {
      expect(cohort.state).toBe("cancelled");
      expect((await ingress.advance(cohort.id, null)).ok).toBe(true);
    }
    expect(await fixture.sql.query("SELECT id FROM oakridge.execution_intent", [])).toEqual([]);
  } finally { await fixture.close(); }
});
