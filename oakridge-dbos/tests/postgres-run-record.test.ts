import { afterAll, expect, test } from "bun:test";

import { ok, type CohortId, type JsonValue, type RunRecordVersion, type StageInstanceId, type WorkflowRunId } from "../src/domain/primitives";
import { createDevFlowAdapterRegistry } from "../src/adapters/dev-flow";
import { BUILD_LAUNCH_REASONS, applyBuildCohortEvent, createBuildCohortMachine,
  initialBuildCohortState } from "../src/adapters/dev-flow-build";
import { applyMigrations } from "../src/storage/migrate";
import { PostgresRunRecordWriter } from "../src/storage/postgres-run-record";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import type { TransitionEffectDescriptor } from "../src/domain/run-record";
import { createScratchDatabase, type ScratchDatabase } from "./support/durable-database";

const RUN_ID = "00000000-0000-4000-8100-000000000001" as WorkflowRunId;
const STAGE_ID = "00000000-0000-4000-8100-000000000002" as StageInstanceId;
const cohortId = (index: number): CohortId =>
  `00000000-0000-4000-8100-${String(index + 10).padStart(12, "0")}` as CohortId;

const scratches: ScratchDatabase[] = [];
afterAll(async () => { for (const scratch of scratches) await scratch.drop(); });

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

test("a build cohort decision commits the machine effect and projected status together", async () => {
  const scratch = await createScratchDatabase("oakridge_v15_build_cohort_decide");
  if (!scratch.ok) {
    if (scratch.error.operation !== "reach_admin_endpoint") throw new Error(`${scratch.error.operation}: ${scratch.error.detail}`);
    console.warn("build cohort PostgreSQL seam check SKIPPED: no PostgreSQL reachable");
    return;
  }
  scratches.push(scratch.value);
  const sql = PgPostgresExecutor.connect(scratch.value.url);
  try {
    await applyMigrations(sql);
    await sql.query(`INSERT INTO oakridge.workflow_definition (id,name,version,definition)
      VALUES ('00000000-0000-4000-8100-000000000000','build-seam',1,'{}')`, []);
    await sql.query(`INSERT INTO oakridge.workflow_run (id,workflow_definition_id,context,bundle_pin,status)
      VALUES ($1,'00000000-0000-4000-8100-000000000000','{}',
        '{"definition_version":1,"prompt_bundle_hash":"test","adapter_version":"test","artifact_schema_version":"test"}','active')`, [RUN_ID]);
    await sql.query(`INSERT INTO oakridge.stage_instance (id,run_id,stage_key,stage_type,stage_contract,status)
      VALUES ($1,$2,'build','delegated_session','{}','active')`, [STAGE_ID, RUN_ID]);
    await sql.query(`INSERT INTO oakridge.cohort (id,run_id,stage_instance_id,cohort_key,status,stage_data)
      VALUES ($1,$2,$3,'cohort-0','pending',$4::jsonb)`,
    [cohortId(0), RUN_ID, STAGE_ID, JSON.stringify(initialBuildCohortState(["pr_summary", "build_result"]))]);

    const prompts = Object.entries(BUILD_LAUNCH_REASONS).flatMap(([session_role, reasons]) => reasons.map((launch_reason) => ({
      stage_key: "build", session_role, launch_reason, template_path: `dev-flow/${session_role}.md`, content: `${session_role}:${launch_reason}`,
    })));
    const machine = createBuildCohortMachine({ required_build_set: ["pr_summary", "build_result"], prompts });
    if (!machine.ok) throw new Error(machine.error);
    const applied = applyBuildCohortEvent(machine.value,
      initialBuildCohortState(["pr_summary", "build_result"]), { kind: "stage_started" });
    const writer = new PostgresRunRecordWriter(sql, createDevFlowAdapterRegistry());
    const decided = await writer.decide({
      load_snapshot: async () => ok({
        run: { id: RUN_ID, status: "active", record_version: 0 as RunRecordVersion, outcome: null },
        stages: [{ id: STAGE_ID, status: "active", blocked_reason: null, next_actor: "core", durable_version: 0,
          dependency_stage_instance_ids: [], accepted_artifact_ids: [], outcome: null,
          cohorts: [{ id: cohortId(0), status: "pending", blocked_reason: null, next_actor: "core", durable_version: 0,
            accepted_artifact_ids: [], outcome: null }] }],
      }),
      decide_snapshot: () => ok({ observed_artifact_ids: [], commands: [{
        kind: "transition_cohort", run_id: RUN_ID, cohort_id: cohortId(0), expected_version: 0,
        change: applied.projection, effect: applied.effect as unknown as TransitionEffectDescriptor,
        stage_data: applied.state as unknown as JsonValue,
      }] }),
      launch_reason: "dependency_satisfied",
      actor: "dev-flow-build",
      decided_at: "2026-09-28T12:00:00.000Z",
    });
    expect(decided.ok).toBe(true);
    const persisted = await sql.query<{ readonly status: string; readonly phase: string; readonly effect_phase: string;
      readonly launch_reason: string; readonly prompt_content: string }>(`SELECT
      cohort.status::text AS status,cohort.stage_data->>'phase' AS phase,
      transition.effect_descriptor->'stage_data'->>'phase' AS effect_phase,
      transition.effect_descriptor->'session_launch'->>'launch_reason' AS launch_reason,
      transition.effect_descriptor->'session_launch'->'prompt'->>'content' AS prompt_content
      FROM oakridge.cohort AS cohort JOIN oakridge.run_transition AS transition ON transition.owner_cohort_id=cohort.id
      WHERE cohort.id=$1`, [cohortId(0)]);
    expect(persisted[0]).toEqual({ status: "active", phase: "builder_active", effect_phase: "builder_active",
      launch_reason: "initial_build", prompt_content: "build:initial_build" });
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
