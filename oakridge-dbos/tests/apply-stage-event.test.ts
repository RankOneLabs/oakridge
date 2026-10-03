import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createDevFlowAdapterRegistry } from "../src/adapters/dev-flow";
import { StageEventApplier } from "../src/storage/apply-stage-event";
import { applyMigrations } from "../src/storage/migrate";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import { PostgresRunRecordWriter, publishWorkerOutput, requestExecutionStop } from "../src/storage/postgres-run-record";
import { dispatchCohortExecution, stopCohortExecution, type CreatedWorkerSession, type WorkerSessionIO } from "../src/runtime/run-launch-dispatch";
import type { ArtifactId, CohortId, ExecutionId, SessionId, StageInstanceId, WorkflowRunId } from "../src/domain/primitives";
import type { ArtifactRef, ImplementationCohortDefinition, ImplementationCohortInputs, OperatorRequestEnvelope } from "../src/domain/dev-flow-v15";
import { createScratchDatabase, type ScratchDatabase } from "./support/durable-database";

const scratches: ScratchDatabase[] = [];
afterAll(async () => { for (const scratch of scratches) await scratch.drop(); });
const definition = (await Bun.file(new URL("../../workflow-config/definitions/dev_flow_v15.json", import.meta.url)).json())
  .stages.implementation.cohort as ImplementationCohortDefinition;
const run_id = "00000000-0000-4000-8900-000000000001" as WorkflowRunId;
const stage_id = "00000000-0000-4000-8900-000000000002" as StageInstanceId;
const cohort_id = "00000000-0000-4000-8900-000000000003" as CohortId;
const brief = { id: "00000000-0000-4000-8900-000000000004" as ArtifactId, version: 1 };
const inputs: ImplementationCohortInputs = { brief, repository: {
  refs: { repository_key: "oakridge" as never, repository_path: "/repo", integration_branch: "epic/wf",
    base_branch: "epic/schema", base_head_sha: "abc" as never },
  worktree_path: "/repo/worktree", worktree_base_sha: "abc" as never,
  canonical_branch: "cohort/core", expected_pr_base: "epic/schema",
} };
interface Fixture {
  readonly sql: PgPostgresExecutor;
  readonly ingress: StageEventApplier;
  readonly created: readonly CreatedWorkerSession[];
  readonly stopped: readonly ExecutionId[];
  readonly io: WorkerSessionIO;
}
const prepare = async (name: string, should_fail_dispatch = false): Promise<Fixture> => {
  const scratch = await createScratchDatabase(name);
  if (!scratch.ok) throw new Error(`${scratch.error.operation}: ${scratch.error.detail}`);
  scratches.push(scratch.value);
  const sql = PgPostgresExecutor.connect(scratch.value.url);
  await applyMigrations(sql);
  const definition_id = "00000000-0000-4000-8900-000000000000";
  await sql.query("INSERT INTO oakridge.workflow_definition (id,name,version,definition) VALUES ($1,'ingress',1,'{}')", [definition_id]);
  await sql.query(`INSERT INTO oakridge.workflow_run (id,workflow_definition_id,context,bundle_pin,status)
    VALUES ($1,$2,$3::jsonb,'{}','active')`, [run_id, definition_id, JSON.stringify({ builder: {
      runtime: "codex", model: "test-model", effort: "high" }, planner: { runtime: "codex", model: "test-planner", effort: null } })]);
  await sql.query(`INSERT INTO oakridge.stage_instance (id,run_id,stage_key,stage_type,stage_contract,status)
    VALUES ($1,$2,'implementation','delegated_session',$3::jsonb,'active')`, [stage_id, run_id, JSON.stringify({ cohort: definition })]);
  await sql.query(`INSERT INTO oakridge.cohort (id,run_id,stage_instance_id,cohort_key,state,status,frozen_inputs)
    VALUES ($1,$2,$3,'core','pending','pending',$4::jsonb)`, [cohort_id, run_id, stage_id, JSON.stringify(inputs)]);
  for (const worker of ["build", "assessment"]) await sql.query("INSERT INTO oakridge.cohort_worker (cohort_id,worker) VALUES ($1,$2)", [cohort_id, worker]);
  await sql.query("INSERT INTO oakridge.artifact (id,chain_id,revision,artifact_type,body) VALUES ($1,$1,1,'dev.build_brief','{}')", [brief.id]);
  await sql.query("INSERT INTO oakridge.artifact_owner (artifact_id,run_id) VALUES ($1,$2)", [brief.id, run_id]);
  const created: CreatedWorkerSession[] = [];
  const stopped: ExecutionId[] = [];
  const io: WorkerSessionIO = {
    now: () => "2026-10-03T00:00:00Z",
    create_session: async (intent) => {
      if (should_fail_dispatch) return { ok: false, error: { detail: "integration refused before creating a session" } };
      const prior = created.find((session) => session.execution_id === intent.execution_id);
      if (prior) return { ok: true, value: prior };
      const session = { execution_id: intent.execution_id, session_id: randomUUID() as SessionId, kbbl_session_id: `kbbl:${intent.execution_id}` };
      created.push(session);
      return { ok: true, value: session };
    },
    stop_session: async (session) => { stopped.push(session.execution_id); return { ok: true, value: undefined }; },
  };
  const ingress = new StageEventApplier({ sql, writer: new PostgresRunRecordWriter(sql, createDevFlowAdapterRegistry()), now: io.now,
    dispatch_executions: async (ids) => { for (const id of ids) await dispatchCohortExecution(sql, id, io); } });
  return { sql, ingress, io, created, stopped };
};

const buildForReview = async (fixture: Fixture): Promise<{ readonly execution_id: ExecutionId; readonly outputs: { readonly build_result: ArtifactRef; readonly pr_summary: ArtifactRef } }> => {
  expect((await fixture.ingress.advance(cohort_id, null)).ok).toBe(true);
  const execution_id = fixture.created[0]!.execution_id;
  const refs: ArtifactRef[] = [];
  for (const [output_name, body] of [["build_result", { summary: "built" }], ["pr_summary", { pr_url: "https://example.test/pr/1" }]] as const) {
    const result = await publishWorkerOutput(fixture.sql, { execution_id, artifact_id: randomUUID() as ArtifactId,
      output_name, collection_key: null, artifact_type: `dev.${output_name}`, body, expected: null, at: fixture.io.now() });
    if (!result.ok) throw new Error(result.error.detail);
    refs.push(result.value);
  }
  const outputs = { build_result: refs[0]!, pr_summary: refs[1]! };
  await fixture.sql.query("UPDATE oakridge.cohort_worker SET response=$2::jsonb WHERE cohort_id=$1 AND worker='build'", [cohort_id,
    JSON.stringify({ execution_id, ...outputs, head_sha: "abc" })]);
  expect((await fixture.ingress.advance(cohort_id, null)).ok).toBe(true);
  return { execution_id, outputs };
};

test("real cohort ingress consumes accept_build once and launches the assessor from the reviewed versions", async () => {
  const fixture = await prepare("oakridge_b2_ingress");
  try {
    const build = await buildForReview(fixture);
    const request: OperatorRequestEnvelope = { id: randomUUID() as never, cohort_id, expected_version: 2,
      request: { kind: "accept_build", target: { outputs: build.outputs, head_sha: "abc" as never } } };
    expect(await fixture.ingress.advance(cohort_id, request)).toEqual({ ok: true, value: { commits: 1, reason: "assessment response pending" } });
    expect(await fixture.ingress.advance(cohort_id, request)).toEqual({ ok: true, value: { commits: 0, reason: "request already consumed" } });
    expect(await fixture.sql.query<{ readonly worker: string; readonly state: string }>(
      "SELECT worker,state FROM oakridge.cohort_worker ORDER BY worker", []))
      .toEqual([{ worker: "assessment", state: "working" }, { worker: "build", state: "accepted" }]);
    expect((await fixture.sql.query<{ readonly receipts: string; readonly intents: string; readonly sessions: string }>(
      `SELECT (SELECT count(*)::text FROM oakridge.cohort_request_receipt) AS receipts,
        (SELECT count(*)::text FROM oakridge.execution_intent) AS intents,
        (SELECT count(*)::text FROM oakridge.session) AS sessions`, []))[0])
      .toEqual({ receipts: "1", intents: "2", sessions: "2" });
    const assessor = (await fixture.sql.query<{ readonly resolved_input: { readonly accepted_build: { readonly outputs: typeof build.outputs } } }>(
      "SELECT resolved_input FROM oakridge.execution_intent WHERE worker='assessment'", []))[0];
    expect(assessor?.resolved_input.accepted_build.outputs).toEqual(build.outputs);
  } finally { await fixture.sql.close(); }
});

test("dispatch replay creates one session and a durable stop converges once after restart", async () => {
  const fixture = await prepare("oakridge_b2_dispatch_replay");
  try {
    await fixture.ingress.advance(cohort_id, null);
    const execution_id = fixture.created[0]!.execution_id;
    await dispatchCohortExecution(fixture.sql, execution_id, fixture.io);
    expect(fixture.created).toHaveLength(1);
    await requestExecutionStop(fixture.sql, execution_id, fixture.io.now());
    expect((await stopCohortExecution(fixture.sql, execution_id, fixture.io)).ok).toBe(true);
    expect((await stopCohortExecution(fixture.sql, execution_id, fixture.io)).ok).toBe(true);
    expect(fixture.stopped).toEqual([execution_id]);
    expect((await fixture.sql.query<{ readonly status: string }>("SELECT status::text FROM oakridge.session", []))[0]?.status).toBe("cancelled");
  } finally { await fixture.sql.close(); }
});

test("an integration failure records an interrupted worker with no fabricated session", async () => {
  const fixture = await prepare("oakridge_b2_dispatch_failure", true);
  try {
    expect(await fixture.ingress.advance(cohort_id, null)).toEqual({ ok: true, value: { commits: 1, reason: "builder retry or abandonment required" } });
    expect((await fixture.sql.query<{ readonly session_count: string; readonly state: string }>(
      `SELECT (SELECT count(*)::text FROM oakridge.session) AS session_count,state
       FROM oakridge.cohort_worker WHERE worker='build'`, []))[0]).toEqual({ session_count: "0", state: "interrupted" });
  } finally { await fixture.sql.close(); }
});

test("legacy event-list ingress cannot mutate a cohort or dispatch work", async () => {
  const fixture = await prepare("oakridge_b2_retired_event");
  try {
    expect(await fixture.ingress.apply(cohort_id, { kind: "started" })).toMatchObject({ ok: false, error: { kind: "event_model_retired" } });
    expect((await fixture.sql.query<{ readonly transitions: string }>("SELECT count(*)::text AS transitions FROM oakridge.run_transition", []))[0])
      .toEqual({ transitions: "0" });
  } finally { await fixture.sql.close(); }
});
