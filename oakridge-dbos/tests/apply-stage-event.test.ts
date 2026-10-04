import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { StageEventApplier } from "../src/storage/apply-stage-event";
import { applyMigrations } from "../src/storage/migrate";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import { PostgresRunRecordWriter, publishWorkerOutput, requestExecutionStop, writeSessionStatus } from "../src/storage/postgres-run-record";
import { PostgresRunRecordRepository } from "../src/storage/postgres-run-record-repository";
import { publishWorkOrderArtifact } from "../src/runtime/publish-work-order-artifact";
import { capabilityFor } from "../src/runtime/publication-capability";
import { dispatchCohortExecution, stopCohortExecution, type CreatedWorkerSession, type WorkerSessionIO } from "../src/runtime/run-launch-dispatch";
import type { ArtifactId, AttemptId, CohortId, ExecutionId, JsonValue, SessionId, StageInstanceId, WorkflowRunId, WorkOrderId } from "../src/domain/primitives";
import type { ArtifactRef, ImplementationCohortDefinition, ImplementationCohortInputs, OperatorRequestEnvelope, VerifiedPrObservation } from "../src/domain/dev-flow-v15";
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
  set_pr(observation: VerifiedPrObservation | null): void;
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
  await sql.query("UPDATE oakridge.cohort SET repository_head_sha='abc' WHERE id=$1", [cohort_id]);
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
  let pr: VerifiedPrObservation | null = null;
  const ingress = new StageEventApplier({ sql, writer: new PostgresRunRecordWriter(sql), now: io.now,
    observe_pr: async () => pr,
    dispatch_executions: async (ids) => { for (const id of ids) await dispatchCohortExecution(sql, id, io); } });
  return { sql, ingress, io, created, stopped, set_pr: (observation) => { pr = observation; } };
};

const buildForReview = async (fixture: Fixture, resumed_execution_id?: ExecutionId): Promise<{ readonly execution_id: ExecutionId; readonly outputs: { readonly build_result: ArtifactRef; readonly pr_summary: ArtifactRef } }> => {
  if (!resumed_execution_id) expect((await fixture.ingress.advance(cohort_id, null)).ok).toBe(true);
  const execution_id = resumed_execution_id ?? fixture.created[0]!.execution_id;
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

test("real storage runs both build feedback routes, discussion, and merge at the accepted head", async () => {
  const fixture = await prepare("oakridge_b3_publication");
  try {
    const records = new PostgresRunRecordRepository(fixture.sql,
      new PostgresRunRecordWriter(fixture.sql), fixture.ingress);
    const seed = await records.load_work_order_capability_seed();
    const publish = async (execution_id: ExecutionId, output_name: string, body: JsonValue) => {
      const row = (await fixture.sql.query<{ readonly attempt_id: AttemptId }>(
        "SELECT attempt_id::text FROM oakridge.execution_intent WHERE id=$1", [execution_id]))[0]!;
      return publishWorkOrderArtifact({ attempt_id: row.attempt_id,
        capability: capabilityFor(seed, row.attempt_id as unknown as WorkOrderId), output_name, collection_key: null,
        body, idempotency_key: `${execution_id}:${output_name}` }, { records, now: fixture.io.now,
        enrich: async () => ({ ok: true, value: output_name === "pr_summary" ? { origin_head_sha: "abc", replace_verification_id: null,
          pr: { provider: "github", owner: "example", name: "oakridge", number: 1,
            url: "https://github.com/example/oakridge/pull/1", head_branch: "cohort/core", base_branch: "epic/schema",
            head_sha: "abc", state: "open", source: "poll", observed_at: fixture.io.now(), merged_at: null } } : null }) });
    };
    const currentVersion = async () => Number((await fixture.sql.query<{ readonly durable_version: string }>(
      "SELECT durable_version::text FROM oakridge.cohort WHERE id=$1", [cohort_id]))[0]!.durable_version);
    const currentBuild = async () => (await fixture.sql.query<{ readonly response: {
      readonly build_result: ArtifactRef; readonly pr_summary: ArtifactRef; readonly head_sha: string } }>(
      "SELECT response FROM oakridge.cohort_worker WHERE cohort_id=$1 AND worker='build'", [cohort_id]))[0]!.response;
    const prBody = { pr_url: "https://github.com/example/oakridge/pull/1", branch: "cohort/core",
      base_branch: "epic/schema", repository_key: "oakridge", summary: "built" };
    expect((await fixture.ingress.advance(cohort_id, null)).ok).toBe(true);
    const build_execution = fixture.created[0]!.execution_id;
    expect((await publish(build_execution, "build_result", { repository_key: "oakridge", summary: "built" })).kind).toBe("published");
    expect((await fixture.sql.query<{ readonly state: string }>(
      "SELECT state FROM oakridge.cohort_worker WHERE cohort_id=$1 AND worker='build'", [cohort_id]))[0]?.state).toBe("working");
    expect((await publish(build_execution, "pr_summary", prBody)).kind).toBe("published");
    let build = await currentBuild();
    expect((await fixture.ingress.advance(cohort_id, { id: randomUUID() as never, cohort_id, expected_version: await currentVersion(),
      request: { kind: "request_build_changes", feedback: { source: "build_review", text: "Add coverage",
        target: { outputs: { build_result: build.build_result, pr_summary: build.pr_summary }, head_sha: build.head_sha as never } } } })).ok).toBe(true);
    const review_revision = fixture.created.at(-1)!.execution_id;
    expect(await publishWorkerOutput(fixture.sql, { execution_id: build_execution,
      artifact_id: randomUUID() as ArtifactId, output_name: "build_result", collection_key: null,
      artifact_type: "dev.build_result", body: { summary: "late write" }, expected: build.build_result,
      at: fixture.io.now() })).toMatchObject({ ok: false, error: { kind: "publication_fenced" } });
    expect((await fixture.sql.query<{ readonly action_point: string; readonly prompt: string; readonly resolved_input: {
      readonly feedback: { readonly source: string } } }>(
      "SELECT action_point,prompt,resolved_input FROM oakridge.execution_intent WHERE id=$1", [review_revision]))[0])
      .toMatchObject({ action_point: "revise", prompt: "workflow-config/prompts/dev-flow/v15/build/build/revise.md",
        resolved_input: { feedback: { source: "build_review" } } });
    expect((await publish(review_revision, "build_result", { repository_key: "oakridge", summary: "revised" })).kind).toBe("published");
    expect((await publish(review_revision, "pr_summary", prBody)).kind).toBe("published");
    build = await currentBuild();
    fixture.set_pr({ pr_url: prBody.pr_url, repository_key: "oakridge" as never, head_branch: "cohort/core",
      base_branch: "epic/schema", head_sha: "abc" as never, state: "closed" });
    expect((await fixture.ingress.advance(cohort_id, { id: randomUUID() as never, cohort_id, expected_version: await currentVersion(),
      request: { kind: "replace_pr", target: { outputs: { build_result: build.build_result, pr_summary: build.pr_summary },
        head_sha: build.head_sha as never } } })).ok).toBe(true);
    const replacement = fixture.created.at(-1)!.execution_id;
    expect((await fixture.sql.query<{ readonly action_point: string; readonly resolved_input: {
      readonly closed_pr: { readonly state: string } } }>(
      "SELECT action_point,resolved_input FROM oakridge.execution_intent WHERE id=$1", [replacement]))[0])
      .toMatchObject({ action_point: "replace_pr", resolved_input: { closed_pr: { state: "closed" } } });
    fixture.set_pr(null);
    expect((await publish(replacement, "build_result", { repository_key: "oakridge", summary: "replacement" })).kind).toBe("published");
    expect((await publish(replacement, "pr_summary", prBody)).kind).toBe("published");
    build = await currentBuild();
    expect((await fixture.ingress.advance(cohort_id, { id: randomUUID() as never, cohort_id, expected_version: await currentVersion(),
      request: { kind: "accept_build", target: { outputs: { build_result: build.build_result, pr_summary: build.pr_summary },
        head_sha: build.head_sha as never } } })).ok).toBe(true);
    const assessment_execution = fixture.created.at(-1)!.execution_id;
    expect((await publish(assessment_execution, "assessment", { verdict: "pass", findings: [], recommended_next_actions: [] })).kind).toBe("published");
    const assessment = (await fixture.sql.query<{ readonly chain_id: ArtifactId; readonly revision: number }>(
      `SELECT artifact.chain_id::text,artifact.revision FROM oakridge.worker_output output
       JOIN oakridge.artifact artifact ON artifact.id=output.artifact_id
       WHERE output.cohort_id=$1 AND output.worker='assessment'`, [cohort_id]))[0]!;
    const accepted = (await fixture.sql.query<{ readonly accepted_build: import("../src/domain/dev-flow-v15").AcceptedBuild }>(
      "SELECT accepted_build FROM oakridge.cohort WHERE id=$1", [cohort_id]))[0]!.accepted_build;
    const assessment_ref = { id: assessment.chain_id, version: assessment.revision };
    expect((await fixture.ingress.advance(cohort_id, { id: randomUUID() as never, cohort_id, expected_version: await currentVersion(),
      request: { kind: "discuss_assessment", feedback: { text: "Please reconsider", target: {
        assessment: assessment_ref, build: accepted } } } })).ok).toBe(true);
    const discussion_execution = fixture.created.at(-1)!.execution_id;
    const before = (await fixture.sql.query<{ readonly count: string }>("SELECT count(*)::text FROM oakridge.artifact", []))[0]!.count;
    expect(await publish(discussion_execution, "assessment_unchanged", { assessment: assessment_ref,
      build: { ...accepted, head_sha: "wrong" }, explanation: "wrong build" } as unknown as JsonValue))
      .toMatchObject({ kind: "refused", code: "assessment_response_mismatch" });
    expect((await publish(discussion_execution, "assessment_unchanged", { assessment: assessment_ref,
      build: accepted, explanation: "The original evidence still satisfies the criterion." } as unknown as JsonValue)).kind).toBe("published");
    const after = (await fixture.sql.query<{ readonly count: string }>("SELECT count(*)::text FROM oakridge.artifact", []))[0]!.count;
    expect(after).toBe(before);
    expect((await fixture.sql.query<{ readonly state: string; readonly response: { readonly kind: string; readonly explanation: string } }>(
      "SELECT state,response FROM oakridge.cohort_worker WHERE cohort_id=$1 AND worker='assessment'", [cohort_id]))[0])
      .toEqual({ state: "awaiting_review", response: expect.objectContaining({ kind: "unchanged",
        explanation: "The original evidence still satisfies the criterion." }) });
    expect((await fixture.ingress.advance(cohort_id, { id: randomUUID() as never, cohort_id, expected_version: await currentVersion(),
      request: { kind: "request_implementation_changes", feedback: { source: "assessment", text: "Fix the finding",
        target: { assessment: assessment_ref, build: accepted } } } })).ok).toBe(true);
    const assessment_revision = fixture.created.at(-1)!.execution_id;
    expect((await fixture.sql.query<{ readonly action_point: string; readonly prompt: string; readonly resolved_input: {
      readonly feedback: { readonly source: string }; readonly current_build: object } }>(
      "SELECT action_point,prompt,resolved_input FROM oakridge.execution_intent WHERE id=$1", [assessment_revision]))[0])
      .toMatchObject({ action_point: "revise", prompt: "workflow-config/prompts/dev-flow/v15/build/build/revise.md",
        resolved_input: { feedback: { source: "assessment" }, current_build: accepted.outputs } });
    expect((await publish(assessment_revision, "build_result", { repository_key: "oakridge", summary: "finding fixed" })).kind).toBe("published");
    expect((await publish(assessment_revision, "pr_summary", prBody)).kind).toBe("published");
    build = await currentBuild();
    expect((await fixture.ingress.advance(cohort_id, { id: randomUUID() as never, cohort_id, expected_version: await currentVersion(),
      request: { kind: "accept_build", target: { outputs: { build_result: build.build_result, pr_summary: build.pr_summary },
        head_sha: build.head_sha as never } } })).ok).toBe(true);
    const fresh_assessment_execution = fixture.created.at(-1)!.execution_id;
    expect((await publish(fresh_assessment_execution, "assessment", { verdict: "pass", findings: [], recommended_next_actions: [] })).kind).toBe("published");
    const freshAssessment = (await fixture.sql.query<{ readonly chain_id: ArtifactId; readonly revision: number }>(
      `SELECT artifact.chain_id::text,artifact.revision FROM oakridge.worker_output output
       JOIN oakridge.artifact artifact ON artifact.id=output.artifact_id
       WHERE output.cohort_id=$1 AND output.worker='assessment'`, [cohort_id]))[0]!;
    const freshAccepted = (await fixture.sql.query<{ readonly accepted_build: import("../src/domain/dev-flow-v15").AcceptedBuild }>(
      "SELECT accepted_build FROM oakridge.cohort WHERE id=$1", [cohort_id]))[0]!.accepted_build;
    expect((await fixture.ingress.advance(cohort_id, { id: randomUUID() as never, cohort_id, expected_version: await currentVersion(),
      request: { kind: "accept_assessment", target: { assessment: { id: freshAssessment.chain_id, version: freshAssessment.revision },
        build: freshAccepted } } })).ok).toBe(true);
    fixture.set_pr({ pr_url: freshAccepted.pr_url, repository_key: "oakridge" as never, head_branch: "cohort/core",
      base_branch: "epic/schema", head_sha: freshAccepted.head_sha, state: "merged" });
    expect((await fixture.ingress.advance(cohort_id, null)).ok).toBe(true);
    expect((await fixture.sql.query<{ readonly state: string }>(
      "SELECT state FROM oakridge.cohort WHERE id=$1", [cohort_id]))[0]?.state).toBe("complete");
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

test("plain session exits leave outputs unready and both workers can retry", async () => {
  const fixture = await prepare("oakridge_b3_worker_retries");
  try {
    const records = new PostgresRunRecordRepository(fixture.sql,
      new PostgresRunRecordWriter(fixture.sql), fixture.ingress);
    const version = async () => Number((await fixture.sql.query<{ readonly durable_version: string }>(
      "SELECT durable_version::text FROM oakridge.cohort WHERE id=$1", [cohort_id]))[0]!.durable_version);
    expect((await fixture.ingress.advance(cohort_id, null)).ok).toBe(true);
    expect((await records.observe_session({ session_id: fixture.created[0]!.session_id,
      health: { kind: "ended_succeeded", metadata: {}, observed_at: fixture.io.now() }, observed_at: fixture.io.now() })).kind).toBe("written");
    expect((await fixture.sql.query<{ readonly state: string; readonly response: unknown }>(
      "SELECT state,response FROM oakridge.cohort_worker WHERE cohort_id=$1 AND worker='build'", [cohort_id]))[0])
      .toEqual({ state: "interrupted", response: null });
    expect((await fixture.ingress.advance(cohort_id, { id: randomUUID() as never, cohort_id, expected_version: await version(),
      request: { kind: "retry_build" } })).ok).toBe(true);
    expect((await fixture.sql.query<{ readonly action_point: string }>(
      "SELECT action_point FROM oakridge.execution_intent WHERE id=$1", [fixture.created.at(-1)!.execution_id]))[0]?.action_point).toBe("retry");
    const build = await buildForReview(fixture, fixture.created.at(-1)!.execution_id);
    expect((await fixture.ingress.advance(cohort_id, { id: randomUUID() as never, cohort_id, expected_version: await version(),
      request: { kind: "accept_build", target: { outputs: build.outputs, head_sha: "abc" as never } } })).ok).toBe(true);
    const assessor = fixture.created.at(-1)!;
    expect((await records.observe_session({ session_id: assessor.session_id,
      health: { kind: "ended_succeeded", metadata: {}, observed_at: fixture.io.now() }, observed_at: fixture.io.now() })).kind).toBe("written");
    expect((await fixture.sql.query<{ readonly state: string; readonly response: unknown }>(
      "SELECT state,response FROM oakridge.cohort_worker WHERE cohort_id=$1 AND worker='assessment'", [cohort_id]))[0])
      .toEqual({ state: "interrupted", response: null });
    expect((await fixture.ingress.advance(cohort_id, { id: randomUUID() as never, cohort_id, expected_version: await version(),
      request: { kind: "retry_assessment" } })).ok).toBe(true);
    expect((await fixture.sql.query<{ readonly action_point: string }>(
      "SELECT action_point FROM oakridge.execution_intent WHERE id=$1", [fixture.created.at(-1)!.execution_id]))[0]?.action_point).toBe("retry");
  } finally { await fixture.sql.close(); }
});

test("an integration failure records an interrupted worker with no fabricated session", async () => {
  const fixture = await prepare("oakridge_b2_dispatch_failure", true);
  try {
    expect(await fixture.ingress.advance(cohort_id, null)).toEqual({ ok: true, value: { commits: 2, reason: "builder retry or abandonment required" } });
    expect((await fixture.sql.query<{ readonly session_count: string; readonly state: string }>(
      `SELECT (SELECT count(*)::text FROM oakridge.session) AS session_count,state
       FROM oakridge.cohort_worker WHERE worker='build'`, []))[0]).toEqual({ session_count: "0", state: "interrupted" });
  } finally { await fixture.sql.close(); }
});


for (const kind of ["cancel", "abandon"] as const) test(`${kind} succeeds during repository and forge failures`, async () => {
  const fixture = await prepare(`oakridge_b3_offline_${kind}`);
  try {
    expect((await fixture.ingress.advance(cohort_id, null)).ok).toBe(true);
    const ingress = new StageEventApplier({ sql: fixture.sql,
      writer: new PostgresRunRecordWriter(fixture.sql), now: fixture.io.now,
      prepare_repository: async () => { throw new Error("repository is offline"); },
      observe_pr: async () => { throw new Error("forge is offline"); },
      dispatch_executions: async (ids) => { for (const id of ids) await dispatchCohortExecution(fixture.sql, id, fixture.io); } });
    const request: OperatorRequestEnvelope = { id: randomUUID() as never, cohort_id, expected_version: 1,
      request: kind === "cancel" ? { kind } : { kind, reason: "repository is offline" } };
    expect((await ingress.advance(cohort_id, request)).ok).toBe(true);
    expect((await fixture.sql.query("SELECT state FROM oakridge.cohort WHERE id=$1", [cohort_id]))[0])
      .toEqual({ state: kind === "cancel" ? "cancelled" : "failed" });
    expect((await fixture.sql.query("SELECT stop_requested_at IS NOT NULL AS fenced FROM oakridge.execution_intent", []))[0])
      .toEqual({ fenced: true });
    expect((await fixture.sql.query("SELECT fenced_at IS NOT NULL AS fenced FROM oakridge.session", []))[0])
      .toEqual({ fenced: true });
    expect(await ingress.advance(cohort_id, request)).toMatchObject({ ok: true, value: { commits: 0 } });
  } finally { await fixture.sql.close(); }
});

for (const worker of ["spec", "plan", "brief", "final_integration"] as const)
  test(`${worker} terminal interruption retains its retry contract and current outputs`, async () => {
    const fixture = await prepare(`oakridge_b3_terminal_${worker}`);
    try {
      await fixture.ingress.advance(cohort_id, null);
      const session = fixture.created[0]!;
      const work = { action_point: "initial", input: { fixture: worker } };
      await fixture.sql.transaction(async (tx) => {
        await tx.query(`INSERT INTO oakridge.cohort_worker (cohort_id,worker,state,work,active_execution_id)
          VALUES ($1,$2,'working',$3::jsonb,$4)`, [cohort_id, worker, JSON.stringify(work), session.execution_id]);
        await tx.query("UPDATE oakridge.execution_intent SET worker=$2 WHERE id=$1", [session.execution_id, worker]);
        await tx.query("UPDATE oakridge.cohort_worker SET active_execution_id=NULL WHERE cohort_id=$1 AND worker='build'", [cohort_id]);
      });
      const output_name = worker === "spec" ? "spec_analysis" : worker === "plan" ? "plan"
        : worker === "brief" ? "briefs" : worker === "final_integration" ? "pr_summary" : "repository_refs";
      const refs: ArtifactRef[] = [];
      for (const collection_key of worker === "brief" ? ["api", "web"] : [null]) {
        const result = await publishWorkerOutput(fixture.sql, { execution_id: session.execution_id,
          artifact_id: randomUUID() as ArtifactId, output_name, collection_key, artifact_type: `dev.${output_name}`,
          body: { partial: true }, expected: null, at: fixture.io.now() });
        if (!result.ok) throw new Error(result.error.detail);
        refs.push(result.value);
      }
      expect(await fixture.sql.transaction((tx) => writeSessionStatus(tx, {
        session_id: session.session_id, status: "failed", at: fixture.io.now() }))).toEqual({ ok: true, value: { kind: "written" } });
      const execution = { execution_id: session.execution_id, session_id: session.session_id,
        detail: "session ended before the required publication was complete" };
      const expected = { work, execution, current: worker === "brief"
          ? { members: [{ cohort_key: "api", ref: refs[0] }, { cohort_key: "web", ref: refs[1] }] } : refs[0] };
      expect((await fixture.sql.query("SELECT interrupted FROM oakridge.cohort_worker WHERE cohort_id=$1 AND worker=$2",
        [cohort_id, worker]))[0]).toEqual({ interrupted: expected });
      expect(await fixture.sql.transaction((tx) => writeSessionStatus(tx, {
        session_id: session.session_id, status: "failed", at: fixture.io.now() }))).toMatchObject({ ok: true, value: { kind: "already_ended" } });
      expect((await fixture.sql.query("SELECT interrupted FROM oakridge.cohort_worker WHERE cohort_id=$1 AND worker=$2",
        [cohort_id, worker]))[0]).toEqual({ interrupted: expected });
    } finally { await fixture.sql.close(); }
  });

for (const cancel_during_outage of [false, true]) test(`lost start response reattaches the original session${cancel_during_outage ? " and honors cancellation" : ""}`, async () => {
  const fixture = await prepare(`oakridge_lost_start_${cancel_during_outage}`);
  try {
    let execution_id: ExecutionId | null = null;
    const uncertain_io: WorkerSessionIO = { ...fixture.io, create_session: async (intent) => {
      execution_id = intent.execution_id;
      await fixture.io.create_session(intent);
      throw new Error("response lost after kbbl started");
    } };
    const ingress = new StageEventApplier({ sql: fixture.sql, writer: new PostgresRunRecordWriter(fixture.sql), now: fixture.io.now,
      dispatch_executions: async (ids) => { for (const id of ids) await dispatchCohortExecution(fixture.sql, id, uncertain_io); } });
    await expect(ingress.advance_local(cohort_id)).rejects.toThrow("response lost after kbbl started");
    expect((await fixture.sql.query("SELECT state FROM oakridge.cohort_worker WHERE worker='build'", []))[0]).toEqual({ state: "working" });
    expect((await fixture.sql.query("SELECT status,session_id FROM oakridge.execution_intent", []))[0]).toEqual({ status: "dispatching", session_id: null });
    if (!execution_id) throw new Error("execution missing");
    if (cancel_during_outage) {
      const records = new PostgresRunRecordRepository(fixture.sql, new PostgresRunRecordWriter(fixture.sql), ingress);
      await records.cancel_run({ run_id, reason: null, cancelled_at: fixture.io.now(), actor: "operator" });
    } else {
      const retry = await fixture.ingress.advance(cohort_id, { id: randomUUID() as never, cohort_id, expected_version: 1, request: { kind: "retry_build" } });
      expect(retry.ok).toBe(false);
    }
    expect((await dispatchCohortExecution(fixture.sql, execution_id, fixture.io)).ok).toBe(true);
    expect(fixture.created).toHaveLength(1);
    expect(fixture.stopped).toEqual(cancel_during_outage ? [execution_id] : []);
  } finally { await fixture.sql.close(); }
});

test("local progression never reads the forge", async () => {
  const fixture = await prepare("oakridge_local_progression");
  try {
    const ingress = new StageEventApplier({ sql: fixture.sql, writer: new PostgresRunRecordWriter(fixture.sql), now: fixture.io.now,
      observe_pr: async () => { throw new Error("unexpected forge call"); },
      dispatch_executions: async (ids) => { for (const id of ids) await dispatchCohortExecution(fixture.sql, id, fixture.io); } });
    expect((await ingress.advance_local(cohort_id)).ok).toBe(true);
    expect((await ingress.advance_local(cohort_id)).ok).toBe(true);
  } finally { await fixture.sql.close(); }
});

test("run deletion removes published outputs and execution references", async () => {
  const fixture = await prepare("oakridge_delete_outputs");
  try {
    await buildForReview(fixture);
    const records = new PostgresRunRecordRepository(fixture.sql, new PostgresRunRecordWriter(fixture.sql), fixture.ingress);
    await records.cancel_run({ run_id, reason: null, cancelled_at: fixture.io.now(), actor: "operator" });
    for (const created of fixture.created) await stopCohortExecution(fixture.sql, created.execution_id, fixture.io);
    expect(await records.delete_run(run_id)).toMatchObject({ kind: "deleted" });
    expect(await fixture.sql.query("SELECT id FROM oakridge.artifact", [])).toEqual([]);
  } finally { await fixture.sql.close(); }
});
