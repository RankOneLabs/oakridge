import { afterAll, expect, test } from "bun:test";

import { ok, type CohortId, type JsonValue, type RunRecordVersion, type StageInstanceId, type WorkflowRunId } from "../src/domain/primitives";
import { createDevFlowAdapterRegistry } from "../src/adapters/dev-flow";
import { applyMigrations } from "../src/storage/migrate";
import { PostgresRunRecordWriter, claimExecutionIntent, commitSelectedCohort,
  publishWorkerOutput, recordExecutionDispatch, requestExecutionStop } from "../src/storage/postgres-run-record";
import type { ImplementationCohortDefinition } from "../src/domain/dev-flow-v15";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import { createScratchDatabase, type ScratchDatabase } from "./support/durable-database";

const RUN_ID = "00000000-0000-4000-8100-000000000001" as WorkflowRunId;
const STAGE_ID = "00000000-0000-4000-8100-000000000002" as StageInstanceId;
const cohortId = (index: number): CohortId =>
  `00000000-0000-4000-8100-${String(index + 10).padStart(12, "0")}` as CohortId;

const scratches: ScratchDatabase[] = [];
afterAll(async () => { for (const scratch of scratches) await scratch.drop(); });

test("selected cohort commit atomically reserves a slot and writes one launch without a session", async () => {
  const scratch = await createScratchDatabase("oakridge_v15_selected_commit");
  if (!scratch.ok) {
    if (scratch.error.operation !== "reach_admin_endpoint") throw new Error(`${scratch.error.operation}: ${scratch.error.detail}`);
    console.warn("selected commit PostgreSQL check SKIPPED: no PostgreSQL reachable");
    return;
  }
  scratches.push(scratch.value);
  const sql = PgPostgresExecutor.connect(scratch.value.url);
  try {
    await applyMigrations(sql);
    await sql.query(`INSERT INTO oakridge.workflow_definition (id,name,version,definition)
      VALUES ('00000000-0000-4000-8100-000000000000','selected',1,'{}')`, []);
    await sql.query(`INSERT INTO oakridge.workflow_run (id,workflow_definition_id,context,bundle_pin,status)
      VALUES ($1,'00000000-0000-4000-8100-000000000000','{}',
        '{"definition_version":1,"prompt_bundle_hash":"test","adapter_version":"test","artifact_schema_version":"test"}','active')`, [RUN_ID]);
    await sql.query(`INSERT INTO oakridge.stage_instance (id,run_id,stage_key,stage_type,stage_contract,status)
      VALUES ($1,$2,'implementation','example','{}','active')`, [STAGE_ID, RUN_ID]);
    for (let index = 0; index < 5; index++) await sql.query(
      `INSERT INTO oakridge.cohort (id,run_id,stage_instance_id,cohort_key,status)
       VALUES ($1,$2,$3,$4,'pending')`, [cohortId(index), RUN_ID, STAGE_ID, `cohort-${index}`]);
    const definition = (await Bun.file(new URL("../../workflow-config/definitions/dev_flow_v15.json", import.meta.url)).json())
      .stages.implementation.cohort as ImplementationCohortDefinition;
    const selected = { kind: "apply", expected_version: 0, changes: [
      { kind: "set_cohort_state", state: "working" },
      { kind: "set_worker_state", worker: "build", state: "working" },
    ], actions: [{ worker: "build", action: { action_point: "initial", input: {
      brief: { id: "00000000-0000-4000-8100-000000000090", version: 1 },
      repository: { refs: { repository_key: "oakridge", repository_path: "/repo", integration_branch: "epic/wf",
        base_branch: "epic/schema", base_head_sha: "abc" }, worktree_path: "/repo/worktree",
        worktree_base_sha: "abc", canonical_branch: "cohort/core", expected_pr_base: "epic/schema" },
    } } }] } as const;
    const input = (index: number) => ({ run_id: RUN_ID, stage_instance_id: STAGE_ID, cohort_id: cohortId(index),
      selected: selected as never, request: null, definition,
      settings: { build: { runtime: "codex" as const, model: null, effort: null },
        assessment: { runtime: "codex" as const, model: null, effort: null } },
      actor: "test", at: "2026-10-02T12:00:00Z" });
    for (let index = 0; index < 4; index++) expect((await commitSelectedCohort(sql, input(index))).ok).toBe(true);
    expect(await commitSelectedCohort(sql, input(4))).toEqual({ ok: false,
      error: { kind: "capacity_full", detail: "four cohorts already hold stage slots" } });
    expect((await sql.query<{ readonly intents: string; readonly sessions: string; readonly transitions: string }>(
      `SELECT (SELECT count(*)::text FROM oakridge.execution_intent) AS intents,
        (SELECT count(*)::text FROM oakridge.session) AS sessions,
        (SELECT count(*)::text FROM oakridge.run_transition) AS transitions`, []))[0])
      .toEqual({ intents: "4", sessions: "0", transitions: "4" });
    expect(await commitSelectedCohort(sql, input(0))).toEqual({ ok: false,
      error: { kind: "version_conflict", expected_version: 0, actual_version: 1 } });
    expect((await commitSelectedCohort(sql, { ...input(1), selected: {
      kind: "apply", expected_version: 1,
      changes: [{ kind: "set_cohort_state", state: "awaiting_merge" }], actions: [],
    } })).ok).toBe(true);
    expect(await commitSelectedCohort(sql, input(4))).toEqual({ ok: false,
      error: { kind: "capacity_full", detail: "four cohorts already hold stage slots" } });
    const buildArtifact = "00000000-0000-4000-8100-000000000091";
    const assessmentArtifact = "00000000-0000-4000-8100-000000000092";
    for (const [artifact_id, worker, output_name] of [
      [buildArtifact, "build", "build_result"], [assessmentArtifact, "assessment", "assessment"],
    ] as const) {
      await sql.query(`INSERT INTO oakridge.artifact (id,chain_id,revision,artifact_type,body)
        VALUES ($1,$1,1,'test.output',$2::jsonb)`, [artifact_id, JSON.stringify({ worker, content: "unchanged" })]);
      await sql.query(`INSERT INTO oakridge.worker_output
        (cohort_id,worker,output_name,artifact_id,acceptance_state,reviewed_target)
        VALUES ($1,$2,$3,$4,'accepted','{}'::jsonb)`, [cohortId(0), worker, output_name, artifact_id]);
    }
    const discussion = await commitSelectedCohort(sql, { ...input(0),
      selected: { kind: "apply", expected_version: 1,
        changes: [{ kind: "clear_acceptance", worker: "assessment" }], actions: [] },
      request: { id: "00000000-0000-4000-8100-000000000080" as never,
        cohort_id: cohortId(0), expected_version: 1,
        request: { kind: "discuss_assessment", feedback: { text: "please clarify",
          target: { assessment: { id: assessmentArtifact as never, version: 1 },
            build: { outputs: { build_result: { id: buildArtifact as never, version: 1 },
              pr_summary: { id: buildArtifact as never, version: 1 } }, pr_url: "https://example.test/pr/1", head_sha: "abc" as never } } } },
      },
    });
    expect(discussion.ok).toBe(true);
    expect(await sql.query<{ readonly worker: string; readonly acceptance_state: string; readonly body: unknown }>(
      `SELECT output.worker,output.acceptance_state,artifact.body
       FROM oakridge.worker_output output JOIN oakridge.artifact artifact ON artifact.id=output.artifact_id
       WHERE output.cohort_id=$1 ORDER BY output.worker`, [cohortId(0)]))
      .toEqual([{ worker: "assessment", acceptance_state: "changes_requested", body: { worker: "assessment", content: "unchanged" } },
        { worker: "build", acceptance_state: "accepted", body: { worker: "build", content: "unchanged" } }]);
    expect((await sql.query<{ readonly receipts: string; readonly intents: string }>(
      `SELECT (SELECT count(*)::text FROM oakridge.cohort_request_receipt) AS receipts,
        (SELECT count(*)::text FROM oakridge.execution_intent) AS intents`, []))[0])
      .toEqual({ receipts: "1", intents: "4" });
    const intents = await sql.query<{ readonly id: string; readonly cohort_id: string }>(
      "SELECT id,cohort_id::text FROM oakridge.execution_intent ORDER BY cohort_id", []);
    const firstExecution = intents[0]!.id as never;
    expect((await claimExecutionIntent(sql, firstExecution)).ok).toBe(true);
    await recordExecutionDispatch(sql, { execution_id: firstExecution, session_id: null,
      detail: "agent session creation failed", at: "2026-10-02T12:01:00Z" });
    expect((await sql.query<{ readonly status: string; readonly session_id: string | null }>(
      "SELECT status,session_id::text FROM oakridge.execution_intent WHERE id=$1", [firstExecution]))[0])
      .toEqual({ status: "interrupted", session_id: null });
    const secondExecution = intents[1]!.id as never;
    await requestExecutionStop(sql, secondExecution, "2026-10-02T12:02:00Z");
    await requestExecutionStop(sql, secondExecution, "2026-10-02T12:03:00Z");
    expect(await claimExecutionIntent(sql, secondExecution)).toEqual({ ok: false, error: { kind: "stopped" } });
    expect((await sql.query<{ readonly stop_count: string }>(
      "SELECT count(*)::text AS stop_count FROM oakridge.execution_intent WHERE id=$1 AND stop_requested_at='2026-10-02T12:02:00Z'",
      [secondExecution]))[0]).toEqual({ stop_count: "1" });
    const builderExecution = intents[2]!.id as never;
    const assessorLaunch = await commitSelectedCohort(sql, { ...input(2), selected: {
      kind: "apply", expected_version: 1,
      changes: [{ kind: "set_worker_state", worker: "assessment", state: "working" }],
      actions: [{ worker: "assessment", action: { action_point: "initial", input: {
        brief: { id: "00000000-0000-4000-8100-000000000090", version: 1 },
        repository: selected.actions[0].action.input.repository,
        accepted_build: { outputs: { build_result: { id: buildArtifact, version: 1 },
          pr_summary: { id: buildArtifact, version: 1 } }, head_sha: "abc", pr_url: "https://example.test/pr/1" },
      } } }],
    } as never });
    expect(assessorLaunch.ok).toBe(true);
    if (!assessorLaunch.ok) throw new Error(assessorLaunch.error.kind);
    const assessorExecution = assessorLaunch.value.execution_ids[0]!;
    expect((await claimExecutionIntent(sql, builderExecution)).ok).toBe(true);
    expect((await claimExecutionIntent(sql, assessorExecution)).ok).toBe(true);
    await recordExecutionDispatch(sql, { execution_id: builderExecution,
      session_id: "00000000-0000-4000-8100-000000000095" as never, detail: null, at: "2026-10-02T12:04:00Z" });
    await recordExecutionDispatch(sql, { execution_id: assessorExecution,
      session_id: "00000000-0000-4000-8100-000000000096" as never, detail: null, at: "2026-10-02T12:04:00Z" });
    expect((await commitSelectedCohort(sql, { ...input(2), selected: {
      kind: "apply", expected_version: 2, changes: [{ kind: "fence_execution", worker: "build" }], actions: [],
    } })).ok).toBe(true);
    expect(await publishWorkerOutput(sql, { execution_id: builderExecution,
      artifact_id: "00000000-0000-4000-8100-000000000093" as never,
      output_name: "build_result", collection_key: null, artifact_type: "test.output",
      body: { text: "stale" }, expected: null, at: "2026-10-02T12:05:00Z" }))
      .toEqual({ ok: false, error: { kind: "publication_fenced",
        detail: `execution ${builderExecution} has no publication authority` } });
    const assessorPublication = await publishWorkerOutput(sql, { execution_id: assessorExecution,
      artifact_id: "00000000-0000-4000-8100-000000000094" as never,
      output_name: "assessment", collection_key: null, artifact_type: "test.output",
      body: { text: "current" }, expected: null, at: "2026-10-02T12:05:00Z" });
    expect(assessorPublication.ok).toBe(true);
    expect((await sql.query<{ readonly fenced_rows: string; readonly assessor_rows: string }>(
      `SELECT (SELECT count(*)::text FROM oakridge.artifact WHERE id='00000000-0000-4000-8100-000000000093') AS fenced_rows,
        (SELECT count(*)::text FROM oakridge.worker_output WHERE cohort_id=$1 AND worker='assessment') AS assessor_rows`,
      [cohortId(2)]))[0]).toEqual({ fenced_rows: "0", assessor_rows: "1" });
    const builderRelaunch = await commitSelectedCohort(sql, { ...input(2), selected: {
      ...selected, expected_version: 3, changes: [{ kind: "set_worker_state", worker: "build", state: "working" }],
    } as never });
    expect(builderRelaunch.ok).toBe(true);
    if (!builderRelaunch.ok) throw new Error(builderRelaunch.error.kind);
    const newBuilderExecution = builderRelaunch.value.execution_ids[0]!;
    expect((await claimExecutionIntent(sql, newBuilderExecution)).ok).toBe(true);
    await recordExecutionDispatch(sql, { execution_id: newBuilderExecution,
      session_id: "00000000-0000-4000-8100-000000000097" as never, detail: null, at: "2026-10-02T12:06:00Z" });
    expect((await publishWorkerOutput(sql, { execution_id: newBuilderExecution,
      artifact_id: "00000000-0000-4000-8100-000000000098" as never,
      output_name: "build_result", collection_key: null, artifact_type: "test.output",
      body: { text: "new builder" }, expected: null, at: "2026-10-02T12:06:00Z" })).ok).toBe(true);
    if (!assessorPublication.ok) throw new Error(assessorPublication.error.kind);
    expect((await publishWorkerOutput(sql, { execution_id: assessorExecution,
      artifact_id: "00000000-0000-4000-8100-000000000099" as never,
      output_name: "assessment", collection_key: null, artifact_type: "test.output",
      body: { text: "assessor still live" }, expected: assessorPublication.value,
      at: "2026-10-02T12:06:00Z" })).ok).toBe(true);
    expect((await sql.query<{ readonly acceptance_state: string; readonly body: unknown }>(
      `SELECT output.acceptance_state,artifact.body FROM oakridge.worker_output output
       JOIN oakridge.artifact artifact ON artifact.id=output.artifact_id
       WHERE output.cohort_id=$1 AND output.worker='assessment'`, [cohortId(2)]))[0])
      .toEqual({ acceptance_state: "unreviewed", body: { text: "assessor still live" } });
    await sql.query("UPDATE oakridge.stage_instance SET status='cancelled',ended_at=now() WHERE id=$1", [STAGE_ID]);
    expect(await claimExecutionIntent(sql, intents[2]!.id as never)).toEqual({ ok: false, error: { kind: "stopped" } });
  } finally { await sql.close(); }
});

test("four sibling cohort machines commit concurrently on owner-local versions without retry", async () => {
  const scratch = await createScratchDatabase("oakridge_v15_cohort_contention");
  if (!scratch.ok) {
    if (scratch.error.operation !== "reach_admin_endpoint") throw new Error(`${scratch.error.operation}: ${scratch.error.detail}`);
    console.warn("cohort contention PostgreSQL check SKIPPED: no PostgreSQL reachable");
    return;
  }
  scratches.push(scratch.value);
  const sql = PgPostgresExecutor.connect(scratch.value.url);
  try {
    await applyMigrations(sql);
    await sql.query(`INSERT INTO oakridge.workflow_definition (id,name,version,definition)
      VALUES ('00000000-0000-4000-8100-000000000000','contention',1,'{}')`, []);
    await sql.query(`INSERT INTO oakridge.workflow_run (id,workflow_definition_id,context,bundle_pin,status)
      VALUES ($1,'00000000-0000-4000-8100-000000000000','{}',
        '{"definition_version":1,"prompt_bundle_hash":"test","adapter_version":"test","artifact_schema_version":"test"}','active')`, [RUN_ID]);
    await sql.query(`INSERT INTO oakridge.stage_instance (id,run_id,stage_key,stage_type,stage_contract,status)
      VALUES ($1,$2,'worker','example','{}','active')`, [STAGE_ID, RUN_ID]);
    for (let index = 0; index < 4; index += 1) await sql.query(
      `INSERT INTO oakridge.cohort (id,run_id,stage_instance_id,cohort_key,status) VALUES ($1,$2,$3,$4,'active')`,
      [cohortId(index), RUN_ID, STAGE_ID, `cohort-${index}`]);

    const registry = createDevFlowAdapterRegistry();
    const customEvent = "example_adapter_finished";
    registry.register_decision<{ readonly output_id: string }>({
      name: customEvent,
      decode(value: JsonValue) {
        if (typeof value === "object" && value !== null && !Array.isArray(value)
          && "output_id" in value && typeof value.output_id === "string") return ok({ output_id: value.output_id });
        return { ok: false, error: "output_id is required" };
      },
      guard: () => ok(undefined),
      effect: (context, payload) => ({ kind: context.event_name, output_id: payload.output_id }),
    });
    const writer = new PostgresRunRecordWriter(sql, registry);
    const results = await Promise.all(Array.from({ length: 4 }, (_, index) => writer.commit({
      run_id: RUN_ID,
      owner: { kind: "cohort", id: cohortId(index) },
      expected_version: 0,
      launch_reason: "artifact_accepted",
      change: { status: "complete", blocked_reason: null, next_actor: null, outcome: { kind: "succeeded" } },
      effect: index === 1 ? { kind: customEvent, output_id: "artifact-1" } : { kind: "none" },
      actor: "test",
      changed_at: "2026-09-28T12:00:00.000Z",
    })));

    expect(results.every((result) => result.ok && result.value.prior_owner_version === 0 && result.value.resulting_owner_version === 1)).toBe(true);
    const versions = await sql.query<{ readonly cohort_versions: string; readonly stage_version: string; readonly run_version: string; readonly transitions: string }>(`SELECT
      (SELECT string_agg(durable_version::text,',' ORDER BY cohort_key) FROM oakridge.cohort WHERE stage_instance_id=$1) AS cohort_versions,
      (SELECT durable_version::text FROM oakridge.stage_instance WHERE id=$1) AS stage_version,
      (SELECT record_version::text FROM oakridge.workflow_run WHERE id=$2) AS run_version,
      (SELECT count(*)::text FROM oakridge.run_transition WHERE run_id=$2) AS transitions`, [STAGE_ID, RUN_ID]);
    expect(versions[0]).toEqual({ cohort_versions: "1,1,1,1", stage_version: "0", run_version: "0", transitions: "4" });
    const effects = await sql.query<{ readonly effect_name: string; readonly workflow_count: string }>(`SELECT
      effect_descriptor->>'kind' AS effect_name,count(DISTINCT effect_workflow_id)::text AS workflow_count
      FROM oakridge.run_transition WHERE run_id=$1 GROUP BY effect_descriptor->>'kind' ORDER BY effect_name`, [RUN_ID]);
    expect(effects).toEqual([
      { effect_name: customEvent, workflow_count: "1" },
      { effect_name: "none", workflow_count: "3" },
    ]);

    const stageDecision = await writer.decide({
      load_snapshot: async () => ok({
        run: { id: RUN_ID, status: "active", record_version: 0 as RunRecordVersion, outcome: null },
        stages: [{ id: STAGE_ID, status: "active", blocked_reason: null, next_actor: "core", durable_version: 0,
          dependency_stage_instance_ids: [], accepted_artifact_ids: [], outcome: null,
          cohorts: Array.from({ length: 4 }, (_, index) => ({ id: cohortId(index), status: "complete" as const,
            blocked_reason: null, next_actor: null, durable_version: 1, accepted_artifact_ids: [], outcome: { kind: "succeeded" } })) }],
      }),
      launch_reason: "dependency_satisfied",
      actor: "core",
      decided_at: "2026-09-28T12:01:00.000Z",
    });
    expect(stageDecision.ok && stageDecision.value.transitions[0]).toMatchObject({
      owner: { kind: "stage_instance", id: STAGE_ID }, prior_owner_version: 0, resulting_owner_version: 1,
    });
    expect((await sql.query<{ readonly run_version: string; readonly stage_version: string }>(`SELECT
      (SELECT record_version::text FROM oakridge.workflow_run WHERE id=$1) AS run_version,
      (SELECT durable_version::text FROM oakridge.stage_instance WHERE id=$2) AS stage_version`, [RUN_ID, STAGE_ID]))[0])
      .toEqual({ run_version: "0", stage_version: "1" });
  } finally {
    await sql.close();
  }
}, 60_000);

test("a concurrent commit loses the cohort version race", async () => {
  const scratch = await createScratchDatabase("oakridge_v15_version_race");
  if (!scratch.ok) {
    if (scratch.error.operation !== "reach_admin_endpoint") throw new Error(`${scratch.error.operation}: ${scratch.error.detail}`);
    console.warn("cohort race PostgreSQL check SKIPPED: no PostgreSQL reachable");
    return;
  }
  scratches.push(scratch.value);
  const firstSql = PgPostgresExecutor.connect(scratch.value.url);
  const secondSql = PgPostgresExecutor.connect(scratch.value.url);
  try {
    await applyMigrations(firstSql);
    await firstSql.query(`INSERT INTO oakridge.workflow_definition (id,name,version,definition)
      VALUES ('00000000-0000-4000-8100-000000000000','version-race',1,'{}')`, []);
    await firstSql.query(`INSERT INTO oakridge.workflow_run (id,workflow_definition_id,context,bundle_pin,status)
      VALUES ($1,'00000000-0000-4000-8100-000000000000','{}',
        '{"definition_version":1,"prompt_bundle_hash":"test","adapter_version":"test","artifact_schema_version":"test"}','active')`, [RUN_ID]);
    await firstSql.query(`INSERT INTO oakridge.stage_instance (id,run_id,stage_key,stage_type,stage_contract,status)
      VALUES ($1,$2,'worker','example','{}','active')`, [STAGE_ID, RUN_ID]);
    await firstSql.query(`INSERT INTO oakridge.cohort (id,run_id,stage_instance_id,cohort_key,status)
      VALUES ($1,$2,$3,'racing','active')`, [cohortId(8), RUN_ID, STAGE_ID]);
    const registry = createDevFlowAdapterRegistry();
    const writerA = new PostgresRunRecordWriter(secondSql, registry);
    const writerB = new PostgresRunRecordWriter(firstSql, registry);
    const input = { run_id: RUN_ID, owner: { kind: "cohort" as const, id: cohortId(8) }, expected_version: 0,
      launch_reason: "operator" as const,
      change: { status: "blocked" as const, blocked_reason: "operator" as const, next_actor: "operator" as const, outcome: null },
      effect: { kind: "none" as const }, actor: "race", changed_at: "2026-09-29T01:00:00Z" };
    const race = await firstSql.transaction(async (tx) => {
      await tx.query("SELECT id FROM oakridge.cohort WHERE id=$1 FOR UPDATE", [cohortId(8)]);
      const competing = writerA.commit(input);
      await Bun.sleep(50);
      const winner = await writerB.commit_in(tx, input);
      return { winner, competing };
    });
    expect(race.winner.ok).toBe(true);
    expect(await race.competing).toMatchObject({ ok: false, error: { kind: "version_conflict" } });
    const rows = await firstSql.query<{ readonly version: string; readonly transitions: string }>(`SELECT
      durable_version::text AS version,
      (SELECT count(*)::text FROM oakridge.run_transition WHERE owner_cohort_id=$1) AS transitions
      FROM oakridge.cohort WHERE id=$1`, [cohortId(8)]);
    expect(rows[0]).toEqual({ version: "1", transitions: "1" });
  } finally { await firstSql.close(); await secondSql.close(); }
}, 60_000);
