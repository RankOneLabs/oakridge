/**
 * Two storage facts a fan-out stage depends on, against a real PostgreSQL.
 *
 * Both were wrong in ways no in-memory test could see:
 *
 * - `publish_artifact` resolved a slot by receiving stage instance and output
 *   name with no cohort predicate, and fan-out cohorts publish with no
 *   collection key. The second cohort of a stage therefore found the first
 *   cohort's parked wait and could never publish. v14's `run_output_slot` was
 *   keyed per unit, so this was a regression, and the build stage declares
 *   `max_parallel: 4`.
 * - `retry_cohort` creates an attempt outside any machine, so nothing started
 *   its workflow. The machine now starts the cohort's latest unfinished attempt
 *   on every pass, which needs that attempt to be in the state it reads.
 *
 * A scratch database, never the dev database: these write real runs.
 */
import { afterAll, expect, test } from "bun:test";

import { createDevFlowAdapterRegistry } from "../src/adapters/dev-flow";
import { attemptIdFor, sessionIdFor, transitionIdFor } from "../src/decision/ids";
import type { AttemptId, CohortId, JsonValue, SessionId, StageInstanceId, WorkflowRunId } from "../src/domain/primitives";
import type { WorkOrderId } from "../src/domain/primitives";
import { publishWorkOrderArtifact } from "../src/runtime/publish-work-order-artifact";
import { capabilityFor, capabilityHash } from "../src/runtime/resolve-work-order";
import { applyMigrations } from "../src/storage/migrate";
import { PostgresRunRecordWriter } from "../src/storage/postgres-run-record";
import { PostgresArtifactRepository } from "../src/storage/postgres-domain";
import { PostgresCollaborationRepository } from "../src/storage/postgres-domain";
import { PostgresOperatorProjectionRepository } from "../src/storage/postgres-operators";
import { PostgresRunRecordRepository } from "../src/storage/postgres-run-record-repository";
import { StageEventApplier } from "../src/storage/apply-stage-event";
import { StageMachineRegistry } from "../src/runtime/executor-registry";
import { PgPostgresExecutor, type TransactionalSqlExecutor } from "../src/storage/sql-executor";
import { createScratchDatabase, type ScratchDatabase } from "./support/durable-database";

const RUN_ID = "00000000-0000-4000-8400-000000000001" as WorkflowRunId;
const DEFINITION_ID = "00000000-0000-4000-8400-000000000000";
const STAGE_ID = "00000000-0000-4000-8400-000000000002" as StageInstanceId;
const RETRY_STAGE_ID = "00000000-0000-4000-8400-000000000003" as StageInstanceId;

const cohortId = (index: number): CohortId =>
  `00000000-0000-4000-8400-${String(index + 100).padStart(12, "0")}` as CohortId;
const attemptId = (index: number): AttemptId =>
  `00000000-0000-4000-8400-${String(index + 200).padStart(12, "0")}` as AttemptId;
const artifactId = (index: number): string =>
  `00000000-0000-4000-8400-${String(index + 300).padStart(12, "0")}`;

const COLLECTION_STAGE_ID = "00000000-0000-4000-8400-000000000004" as StageInstanceId;

const gatedOutput = (name: string, artifact_type: string): JsonValue => ({
  name, artifact_type,
  release: { kind: "gate", gate_name: `${name}_review`,
    steps: [{ type: "artifact_approval", actions: [{ name: "approve", disposition: "release" },
      { name: "request_revision", disposition: "revise" }] }] },
});

/** One gated output, which is what makes a publication park on a wait. */
const BUILD_MACHINE: JsonValue = {
  initial: "working", stage_type: "delegated_session",
  states: {
    working: { status: "active", blocked_reason: null, next_actor: "agent", session_role: "build" },
    build_review: { status: "blocked", blocked_reason: "gate", next_actor: "operator", session_role: null },
    done: { status: "complete", blocked_reason: null, next_actor: null, session_role: null },
  },
  transitions: [
    { from: "working", on: { event: "artifact_published", output: "build_result" }, guard: null,
      to: "build_review", effects: [{ name: "record_output", args: {} },
        { name: "open_gate", args: { gate: "build_result_review", outputs: ["build_result"] } }] },
    { from: "build_review", on: { event: "gate_decided", gate: "build_result_review", action: "approve" },
      guard: null, to: "done", effects: [{ name: "accept_outputs", args: { outputs: ["build_result"] } }] },
    { from: "build_review", on: { event: "gate_decided", gate: "build_result_review", action: "request_revision" },
      guard: null, to: "working", effects: [{ name: "new_round", args: {} },
        { name: "launch_session", args: { role: "build", reason: "input_revision" } }] },
  ],
};
const COLLECTION_MACHINE: JsonValue = {
  initial: "working", stage_type: "delegated_session",
  states: { working: { status: "active", blocked_reason: null, next_actor: "agent", session_role: "brief" } },
  transitions: [{ from: "working", on: { event: "artifact_published", output: "brief" }, guard: null,
    to: "working", effects: [{ name: "record_output", args: {} },
      { name: "accept_outputs", args: { outputs: ["brief"] } }] }],
};
const STAGE_CONTRACT: JsonValue = { stage_key: "build", outputs: [gatedOutput("build_result", "dev.build_result")],
  materialization: { kind: "fan_out", max_parallel: 4 }, machine: BUILD_MACHINE,
  executor: { executor_type: "delegated_session", definition_config: {} } };
/** A collecting output: one cohort publishes it once per collection key. */
const COLLECTION_CONTRACT: JsonValue = { stage_key: "brief_writer", outputs: [gatedOutput("brief", "dev.build_brief")],
  materialization: { kind: "artifact_collections" }, machine: COLLECTION_MACHINE,
  executor: { executor_type: "delegated_session", definition_config: {} } };

const STAGES: readonly { readonly id: StageInstanceId; readonly key: string; readonly contract: JsonValue }[] = [
  { id: STAGE_ID, key: "build", contract: STAGE_CONTRACT },
  { id: RETRY_STAGE_ID, key: "build_retry", contract: STAGE_CONTRACT },
  { id: COLLECTION_STAGE_ID, key: "brief_writer", contract: COLLECTION_CONTRACT },
];

const scratches: ScratchDatabase[] = [];
afterAll(async () => { for (const scratch of scratches) await scratch.drop(); }, 30_000);

interface Prepared {
  readonly url: string;
  readonly sql: TransactionalSqlExecutor & { close(): Promise<void> };
  readonly records: PostgresRunRecordRepository;
  readonly seed: string;
}

/** The scratch database, or null when no PostgreSQL is reachable (a loud skip). */
const prepare = async (name: string): Promise<Prepared | null> => {
  const scratch = await createScratchDatabase(name);
  if (!scratch.ok) {
    if (scratch.error.operation !== "reach_admin_endpoint") throw new Error(`${scratch.error.operation}: ${scratch.error.detail}`);
    console.warn(`${name} PostgreSQL check SKIPPED: no PostgreSQL reachable`);
    return null;
  }
  scratches.push(scratch.value);
  const sql = PgPostgresExecutor.connect(scratch.value.url);
  await applyMigrations(sql);
  await sql.query(`INSERT INTO oakridge.workflow_definition (id,name,version,definition)
    VALUES ($1,'fan_out',1,'{}')`, [DEFINITION_ID]);
  await sql.query(`INSERT INTO oakridge.workflow_run (id,workflow_definition_id,context,bundle_pin,status)
    VALUES ($1,$2,'{}','{"definition_version":1,"prompt_bundle_hash":"test","adapter_version":"test","artifact_schema_version":"test"}','active')`,
    [RUN_ID, DEFINITION_ID]);
  for (const stage of STAGES) {
    await sql.query(`INSERT INTO oakridge.stage_instance (id,run_id,stage_key,stage_type,stage_contract,status)
      VALUES ($1,$2,$3,'delegated_session',$4::jsonb,'active')`,
      [stage.id, RUN_ID, stage.key, JSON.stringify(stage.contract)]);
  }
  const writer = new PostgresRunRecordWriter(sql, createDevFlowAdapterRegistry());
  const stageEvents = new StageEventApplier({ sql, writer, registry: new StageMachineRegistry(),
    registered_effects: new Map(), load_stage_inputs: async () => ({}),
    start_effects: async () => {}, now: () => "2026-09-29T00:00:00.000Z" });
  const records = new PostgresRunRecordRepository(sql, writer, stageEvents);
  return { url: scratch.value.url, sql, records, seed: await records.load_work_order_capability_seed() };
};

const openCohort = async (sql: Prepared["sql"], stage: StageInstanceId, cohort: CohortId, key: string): Promise<void> => {
  await sql.query(`INSERT INTO oakridge.cohort (id,run_id,stage_instance_id,cohort_key,stage_data,state,status)
    VALUES ($1,$2,$3,$4,'{}','working','active')`, [cohort, RUN_ID, stage, key]);
};

const startAttempt = async (
  sql: Prepared["sql"],
  input: { readonly stage: StageInstanceId; readonly cohort: CohortId; readonly attempt: AttemptId;
    readonly number: number; readonly status: "active" | "failed"; readonly request: JsonValue },
): Promise<void> => {
  await sql.query(`INSERT INTO oakridge.attempt (id,run_id,stage_instance_id,cohort_id,attempt_number,adapter_type,request,status,ended_at)
    VALUES ($1,$2,$3,$4,$5,'delegated_session',$6::jsonb,$7::oakridge.attempt_status,
      CASE WHEN $7='failed' THEN now() ELSE NULL END)`,
    [input.attempt, RUN_ID, input.stage, input.cohort, input.number, JSON.stringify(input.request), input.status]);
};

const publish = (prepared: Prepared, attempt: AttemptId, artifact: string,
  slot: { readonly output_name?: string; readonly collection_key?: string } = {}) =>
  prepared.records.publish_artifact({
    artifact_id: artifact as unknown as import("../src/domain/primitives").ArtifactId,
    attempt_id: attempt,
    capability_hash: capabilityHash(capabilityFor(prepared.seed, attempt as unknown as WorkOrderId)),
    output_name: slot.output_name ?? "build_result", body: { summary: artifact },
    collection_key: (slot.collection_key ?? null) as never,
    idempotency_key: `publish:${artifact}`, payload_hash: artifact,
    published_at: "2026-09-29T00:00:00.000Z",
  });

const launchReplacement = async (
  records: PostgresRunRecordRepository, cohort: CohortId, stage: StageInstanceId,
  replacement: AttemptId, key: string,
) => {
  const state = await records.find_cohort_state(cohort);
  if (!state) throw new Error("cohort disappeared");
  const attempt_number = state.attempt_count + 1;
  return records.commit_cohort_launch({
    event: { run_id: RUN_ID, cohort_id: cohort, expected_version: state.durable_version,
      change: { status: "active", blocked_reason: null, next_actor: "agent", outcome: null },
      stage_data: state.stage_data, reopen_output_names: [],
      effect: { kind: "start_attempt", cohort_id: cohort, attempt_number },
      launch_reason: "retry", actor: "operator", recorded_at: "2026-09-29T01:00:00Z" },
    attempt: { run_id: RUN_ID, stage_instance_id: stage, cohort_id: cohort,
      attempt_id: replacement, attempt_number, adapter_type: "delegated_session", request: {} as never,
      launch_transition_id: transitionIdFor({ kind: "cohort", id: cohort }, state.durable_version + 1),
      session_id: sessionIdFor(replacement), idempotency_key: key, created_at: "2026-09-29T01:00:00Z" },
  });
};

test("a lost publication response can be replayed while its build gate is open", async () => {
  const prepared = await prepare("oakridge_v15_review_replay");
  if (!prepared) return;
  try {
    await openCohort(prepared.sql, STAGE_ID, cohortId(30), "replay");
    await startAttempt(prepared.sql, { stage: STAGE_ID, cohort: cohortId(30), attempt: attemptId(30),
      number: 1, status: "active", request: {} });
    expect((await publish(prepared, attemptId(30), artifactId(30))).kind).toBe("published");
    expect(await publish(prepared, attemptId(30), artifactId(30))).toMatchObject({
      kind: "already_applied", artifact_id: artifactId(30),
    });
    expect(await publish(prepared, attemptId(30), artifactId(31))).toMatchObject({
      kind: "refused", code: "awaiting_review",
    });
    const replay = { attempt_id: attemptId(30), capability: capabilityFor(prepared.seed, attemptId(30) as unknown as WorkOrderId),
      output_name: "build_result", collection_key: null, body: { summary: artifactId(30) }, idempotency_key: null };
    const dependencies = { records: prepared.records, now: () => "2026-09-29T00:00:00.000Z",
      enrich: async () => { throw new Error("replay or invalid capability must not read GitHub"); } };
    expect(await publishWorkOrderArtifact(replay, dependencies)).toMatchObject({
      kind: "already_applied", artifact_id: artifactId(30),
    });
    expect(await publishWorkOrderArtifact({ ...replay, capability: "invalid" }, dependencies)).toMatchObject({
      kind: "invalid_capability",
    });
    const rows = await prepared.sql.query<{ readonly artifacts: string; readonly transitions: string }>(
      `SELECT (SELECT count(*)::text FROM oakridge.artifact_owner WHERE cohort_id=$1) AS artifacts,
              (SELECT count(*)::text FROM oakridge.run_transition WHERE owner_cohort_id=$1) AS transitions`, [cohortId(30)]);
    expect(rows).toEqual([{ artifacts: "1", transitions: "1" }]);
  } finally { await prepared.sql.close(); }
});

for (const status of ["complete", "failed", "cancelled"] as const) {
  test(`a late roster failure leaves a ${status} stage terminal without another transition`, async () => {
    const prepared = await prepare(`oakridge_v15_roster_${status}`);
    if (!prepared) return;
    try {
      const writer = new PostgresRunRecordWriter(prepared.sql, createDevFlowAdapterRegistry());
      const changed = await writer.commit({ run_id: RUN_ID, owner: { kind: "stage_instance", id: STAGE_ID },
        expected_version: 0, launch_reason: "operator",
        change: { status, blocked_reason: null, next_actor: null, outcome: { kind: status } },
        effect: { kind: "none" }, actor: "test", changed_at: "2026-09-29T00:00:00Z" });
      if (!changed.ok) throw new Error(JSON.stringify(changed.error));
      expect(await prepared.records.fail_stage_roster(STAGE_ID, "late roster result", "2026-09-29T00:01:00Z"))
        .toEqual({ ok: true, value: undefined });
      expect(await prepared.sql.query<{ readonly status: string; readonly version: string }>(
        "SELECT status,durable_version::text AS version FROM oakridge.stage_instance WHERE id=$1", [STAGE_ID]))
        .toEqual([{ status, version: "1" }]);
    } finally { await prepared.sql.close(); }
  });
}

test("two cohorts of one stage instance each publish the stage's declared output", async () => {
  const prepared = await prepare("oakridge_v15_fan_out_publish");
  if (!prepared) return;
  try {
    await openCohort(prepared.sql, STAGE_ID, cohortId(1), "foundation");
    await openCohort(prepared.sql, STAGE_ID, cohortId(2), "web");
    await startAttempt(prepared.sql, { stage: STAGE_ID, cohort: cohortId(1), attempt: attemptId(1), number: 1, status: "active", request: {} });
    await startAttempt(prepared.sql, { stage: STAGE_ID, cohort: cohortId(2), attempt: attemptId(2), number: 1, status: "active", request: {} });

    const first = await publish(prepared, attemptId(1), artifactId(1));
    const second = await publish(prepared, attemptId(2), artifactId(2));
    expect(first.kind).toBe("published");
    expect(second.kind).toBe("published");
    if (first.kind !== "published" || second.kind !== "published") return;
    expect(second.cohort_id).toBe(cohortId(2));

    // Each cohort holds its own parked revision, and its own wait.
    const owners = await prepared.sql.query<{ readonly cohort_id: string; readonly artifact_id: string; readonly waits: string }>(
      `SELECT owner.cohort_id::text,owner.artifact_id::text,
              (SELECT count(*)::text FROM oakridge.wait_gate wait WHERE wait.cohort_id=owner.cohort_id AND wait.status='open') AS waits
       FROM oakridge.artifact_owner owner WHERE owner.run_id=$1 ORDER BY owner.cohort_id`, [RUN_ID]);
    expect(owners).toEqual([
      { cohort_id: cohortId(1), artifact_id: artifactId(1), waits: "1" },
      { cohort_id: cohortId(2), artifact_id: artifactId(2), waits: "1" },
    ].sort((left, right) => left.cohort_id.localeCompare(right.cohort_id)));

    // Releasing one cohort's gate leaves the other's slot alone.
    const firstGate = (await prepared.sql.query<{ readonly id: string }>(
      "SELECT id::text FROM oakridge.wait_gate WHERE cohort_id=$1", [cohortId(1)]))[0];
    if (!firstGate) throw new Error("first cohort gate was not opened");
    const released = await prepared.records.decide_gate_wait({ wait_id: firstGate.id as never, action: "approve",
      actor: "operator", detail: null, decided_at: "2026-09-29T00:01:00.000Z" });
    expect(released.kind).toBe("decided");
    const secondWaits = await prepared.sql.query<{ readonly id: string }>(
      "SELECT id::text FROM oakridge.wait_gate WHERE cohort_id=$1 AND status='open'", [cohortId(2)]);
    expect(secondWaits).toHaveLength(1);
  } finally {
    await prepared.sql.close();
  }
});

test("publishing after new_round keeps revision 2 in revision 1's chain", async () => {
  const prepared = await prepare("oakridge_v15_reopened_build_slot");
  if (!prepared) return;
  try {
    const cohort = cohortId(3);
    await openCohort(prepared.sql, STAGE_ID, cohort, "foundation");
    await startAttempt(prepared.sql, { stage: STAGE_ID, cohort, attempt: attemptId(3),
      number: 1, status: "active", request: {} });
    const first = await publish(prepared, attemptId(3), artifactId(3));
    expect(first.kind).toBe("published");
    const gate = (await prepared.sql.query<{ readonly id: string }>(
      "SELECT id::text FROM oakridge.wait_gate WHERE cohort_id=$1 AND status='open'", [cohort]))[0];
    if (!gate) throw new Error("round 1 gate was not opened");
    const revised = await prepared.records.decide_gate_wait({ wait_id: gate.id as never, action: "request_revision",
      actor: "operator", detail: "Please revise", decided_at: "2026-09-29T00:01:00.000Z" });
    expect(revised.kind).toBe("decided");
    const second = await publish(prepared, attemptIdFor(cohort, 2), artifactId(13));
    expect(second.kind).toBe("published");
    const revisions = await prepared.sql.query<{ readonly id: string; readonly chain_id: string;
      readonly revision: number; readonly parent_artifact_id: string | null }>(
      `SELECT id::text,chain_id::text,revision,parent_artifact_id::text FROM oakridge.artifact
       WHERE id=ANY($1::uuid[]) ORDER BY revision`, [[artifactId(3), artifactId(13)]]);
    expect(revisions).toEqual([
      { id: artifactId(3), chain_id: artifactId(3), revision: 1, parent_artifact_id: null },
      { id: artifactId(13), chain_id: artifactId(3), revision: 2, parent_artifact_id: artifactId(3) },
    ]);
  } finally {
    await prepared.sql.close();
  }
});

/**
 * The planner publishes one brief per cohort into the same declared output, each
 * under its own collection key. Keyed by artifact type, the second publication
 * became revision 2 of the first's chain and superseded it — so the build stage
 * fanned out over one brief and opened one cohort instead of two.
 */
test("a collecting output keeps one revision chain per collection key", async () => {
  const prepared = await prepare("oakridge_v15_collection_chains");
  if (!prepared) return;
  try {
    await openCohort(prepared.sql, COLLECTION_STAGE_ID, cohortId(8), "0");
    await startAttempt(prepared.sql, { stage: COLLECTION_STAGE_ID, cohort: cohortId(8), attempt: attemptId(8), number: 1, status: "active", request: {} });

    const foundation = await publish(prepared, attemptId(8), artifactId(8), { output_name: "brief", collection_key: "foundation" });
    const web = await publish(prepared, attemptId(8), artifactId(9), { output_name: "brief", collection_key: "web" });
    expect([foundation.kind, web.kind]).toEqual(["published", "published"]);

    const chains = await prepared.sql.query<{ readonly id: string; readonly chain_id: string; readonly revision: number; readonly lifecycle: string }>(
      `SELECT artifact.id::text,artifact.chain_id::text,artifact.revision,artifact.lifecycle
         FROM oakridge.artifact artifact
         JOIN oakridge.artifact_owner owner ON owner.artifact_id=artifact.id
        WHERE owner.cohort_id=$1 ORDER BY artifact.id`, [cohortId(8)]);
    // Two chains at revision 1, both still current: neither supersedes the other.
    expect(chains).toEqual([
      { id: artifactId(8), chain_id: artifactId(8), revision: 1, lifecycle: "released" },
      { id: artifactId(9), chain_id: artifactId(9), revision: 1, lifecycle: "released" },
    ]);

    // Both releases are visible to the downstream stage that collects them.
    const artifacts = new PostgresArtifactRepository(prepared.sql);
    const collected = await artifacts.list_released_for_stage_output(COLLECTION_STAGE_ID, "brief");
    expect(collected.map((revision) => revision.collection_key as string | null)).toEqual(["foundation", "web"]);
  } finally {
    await prepared.sql.close();
  }
});

test("an attempt created by an operator retry is the attempt the cohort machine starts", async () => {
  const prepared = await prepare("oakridge_v15_retry_attempt");
  if (!prepared) return;
  try {
    await openCohort(prepared.sql, RETRY_STAGE_ID, cohortId(5), "web");
    // A finished attempt carrying publication authority is what a retry rebinds.
    await startAttempt(prepared.sql, { stage: RETRY_STAGE_ID, cohort: cohortId(5), attempt: attemptId(5), number: 1, status: "failed",
      request: { execution_id: attemptId(5), stage_instance_id: RETRY_STAGE_ID, unit_id: "web",
        executor_type: "delegated_session",
        resolved_config: { rendered_prompt: "go", publication: { base_url: "http://127.0.0.1:1", work_order_id: attemptId(5), capability: "cap" } },
        inputs: [], declared_outputs: [{ name: "build_result", artifact_type: "dev.build_result", required: true }],
        expected_artifacts: [{ unit_id: "web", output_name: "build_result", artifact_type: "dev.build_result" }] } });

    const retried = await launchReplacement(prepared.records, cohortId(5), RETRY_STAGE_ID,
      attemptIdFor(cohortId(5), 2), "retry-1");
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.value.attempt_id).toBe(attemptIdFor(cohortId(5), 2));

    const state = await prepared.records.find_cohort_state(cohortId(5));
    expect(state?.latest_unfinished_attempt_id).toBe(retried.value.attempt_id);
    // The replaced attempt is not a candidate: it ended when the retry abandoned it.
    expect(state?.attempt_count).toBe(2);
  } finally {
    await prepared.sql.close();
  }
});

test("a cohort decision read before cancellation cannot un-cancel the cohort", async () => {
  const prepared = await prepare("oakridge_v15_stale_cohort_decision");
  if (!prepared) return;
  try {
    await openCohort(prepared.sql, STAGE_ID, cohortId(20), "stale");
    const stale = await prepared.records.find_cohort_state(cohortId(20));
    if (!stale) throw new Error("cohort was not created");
    const writer = new PostgresRunRecordWriter(prepared.sql, createDevFlowAdapterRegistry());
    const cancelled = await writer.commit({ run_id: RUN_ID, owner: { kind: "cohort", id: cohortId(20) },
      expected_version: stale.durable_version, launch_reason: "operator",
      change: { status: "cancelled", blocked_reason: null, next_actor: null, outcome: { kind: "cancelled" } },
      effect: { kind: "none" }, actor: "operator", changed_at: "2026-09-29T01:00:00Z" });
    expect(cancelled.ok).toBe(true);
    const decision = { run_id: RUN_ID, cohort_id: cohortId(20), expected_version: stale.durable_version,
      change: { status: "active" as const, blocked_reason: null, next_actor: "agent" as const, outcome: null },
      stage_data: {}, reopen_output_names: [], effect: { kind: "none" as const }, launch_reason: "operator" as const,
      actor: "stale-reader", recorded_at: "2026-09-29T01:01:00Z" };
    expect((await prepared.records.record_cohort_event(decision)).kind).toBe("version_conflict");
    const rows = await prepared.sql.query<{ readonly status: string; readonly version: string; readonly transitions: string }>(
      `SELECT status::text, durable_version::text AS version,
        (SELECT count(*)::text FROM oakridge.run_transition WHERE owner_cohort_id=$1) AS transitions
       FROM oakridge.cohort WHERE id=$1`, [cohortId(20)]);
    expect(rows[0]).toEqual({ status: "cancelled", version: "1", transitions: "1" });
  } finally { await prepared.sql.close(); }
});

test("a commit against a terminal cohort at its current version returns owner_terminal", async () => {
  const prepared = await prepare("oakridge_v15_terminal_cohort_guard");
  if (!prepared) return;
  try {
    await openCohort(prepared.sql, STAGE_ID, cohortId(21), "terminal");
    await prepared.sql.query("UPDATE oakridge.cohort SET status='failed',ended_at=now() WHERE id=$1", [cohortId(21)]);
    const writer = new PostgresRunRecordWriter(prepared.sql, createDevFlowAdapterRegistry());
    const committed = await writer.commit({ run_id: RUN_ID, owner: { kind: "cohort", id: cohortId(21) },
      expected_version: 0, launch_reason: "operator",
      change: { status: "active", blocked_reason: null, next_actor: "agent", outcome: null },
      effect: { kind: "none" }, actor: "test", changed_at: "2026-09-29T01:00:00Z" });
    expect(committed).toMatchObject({ ok: false, error: { kind: "owner_terminal", status: "failed" } });
  } finally { await prepared.sql.close(); }
});

test("a commit against a terminal stage at its current version returns owner_terminal", async () => {
  const prepared = await prepare("oakridge_v15_terminal_stage_guard");
  if (!prepared) return;
  try {
    await prepared.sql.query("UPDATE oakridge.stage_instance SET status='failed',ended_at=now() WHERE id=$1", [STAGE_ID]);
    const writer = new PostgresRunRecordWriter(prepared.sql, createDevFlowAdapterRegistry());
    const committed = await writer.commit({ run_id: RUN_ID, owner: { kind: "stage_instance", id: STAGE_ID },
      expected_version: 0, launch_reason: "operator",
      change: { status: "active", blocked_reason: null, next_actor: "agent", outcome: null },
      effect: { kind: "none" }, actor: "test", changed_at: "2026-09-29T01:00:00Z" });
    expect(committed).toMatchObject({ ok: false, error: { kind: "owner_terminal", status: "failed" } });
    const rows = await prepared.sql.query<{ readonly status: string; readonly version: string; readonly transitions: string }>(
      `SELECT status::text, durable_version::text AS version,
        (SELECT count(*)::text FROM oakridge.run_transition WHERE owner_stage_instance_id=$1) AS transitions
       FROM oakridge.stage_instance WHERE id=$1`, [STAGE_ID]);
    expect(rows[0]).toEqual({ status: "failed", version: "0", transitions: "0" });
  } finally { await prepared.sql.close(); }
});

test("binding after abandonment preserves cancelled attempt and session", async () => {
  const prepared = await prepare("oakridge_v15_abandoned_bind");
  if (!prepared) return;
  try {
    await openCohort(prepared.sql, STAGE_ID, cohortId(22), "abandoned");
    await startAttempt(prepared.sql, { stage: STAGE_ID, cohort: cohortId(22), attempt: attemptId(22),
      number: 1, status: "active", request: {} });
    const session_id = "00000000-0000-4000-8400-000000000422" as SessionId;
    const transition_id = "00000000-0000-4000-8400-000000000423";
    await prepared.sql.query("UPDATE oakridge.cohort SET durable_version=1 WHERE id=$1", [cohortId(22)]);
    await prepared.sql.query(`INSERT INTO oakridge.run_transition
      (id,run_id,owner_kind,owner_cohort_id,launch_reason,prior_owner_version,resulting_owner_version,
       event,effect_descriptor,effect_workflow_id,actor)
      VALUES ($1,$2,'cohort',$3,'initial',0,1,'{"kind":"derive"}','{"kind":"start_attempt"}','test:abandoned-bind','test')`,
      [transition_id, RUN_ID, cohortId(22)]);
    await prepared.sql.query(`INSERT INTO oakridge.session
      (id,run_id,stage_instance_id,attempt_id,launch_transition_id,status,adapter_reference,ended_at)
      VALUES ($1,$2,$3,$4,$5,'cancelled','{"kind":"none"}',now())`,
      [session_id, RUN_ID, STAGE_ID, attemptId(22), transition_id]);
    await prepared.sql.query("UPDATE oakridge.attempt SET status='cancelled',ended_at=now() WHERE id=$1", [attemptId(22)]);
    const result = await prepared.records.bind_session({ session_id, adapter_reference: { kind: "kbbl_session", session_id: "late" as never },
      kbbl_session_id: "late" as never, bound_at: "2026-09-29T01:00:00Z" });
    expect(result).toMatchObject({ kind: "attempt_ended", status: "cancelled" });
    const rows = await prepared.sql.query<{ readonly session_status: string; readonly attempt_status: string;
      readonly adapter_reference: JsonValue }>(`SELECT session.status::text AS session_status,attempt.status::text AS attempt_status,
      session.adapter_reference FROM oakridge.session session JOIN oakridge.attempt attempt ON attempt.id=session.attempt_id
      WHERE session.id=$1`, [session_id]);
    expect(rows[0]).toMatchObject({ session_status: "cancelled", attempt_status: "cancelled",
      adapter_reference: { kind: "kbbl_session", session_id: "late" } });
    await prepared.records.mark_session_fenced(session_id, "2026-09-29T01:02:00Z");
    const fenced = await prepared.sql.query<{ readonly status: string; readonly fenced_at: string | null }>(
      "SELECT status::text,fenced_at::text FROM oakridge.session WHERE id=$1", [session_id]);
    expect(fenced[0]?.status).toBe("cancelled");
    expect(fenced[0]?.fenced_at).not.toBeNull();
  } finally { await prepared.sql.close(); }
});

test("a second accepted revision in one cohort slot is rejected", async () => {
  const prepared = await prepare("oakridge_v15_unique_acceptance_slot");
  if (!prepared) return;
  try {
    await openCohort(prepared.sql, STAGE_ID, cohortId(23), "slot");
    const columns = await prepared.sql.query<{ readonly column_name: string }>(`SELECT column_name
      FROM information_schema.columns WHERE table_schema='oakridge' AND table_name='artifact_acceptance'
        AND column_name='cohort_id'`, []);
    for (const artifact of [artifactId(23), artifactId(24)]) {
      await prepared.sql.query(`INSERT INTO oakridge.artifact (id,chain_id,revision,artifact_type,body)
        VALUES ($1,$1,1,'dev.build_result','{}')`, [artifact]);
      await prepared.sql.query("INSERT INTO oakridge.artifact_owner (artifact_id,run_id,stage_instance_id,cohort_id) VALUES ($1,$2,$3,$4)",
        [artifact, RUN_ID, STAGE_ID, cohortId(23)]);
    }
    const insertAcceptance = (artifact: string) => columns.length > 0
      ? prepared.sql.query(`INSERT INTO oakridge.artifact_acceptance
          (artifact_id,run_id,receiving_stage_instance_id,cohort_id,output_name,artifact_type)
          VALUES ($1,$2,$3,$4,'build_result','dev.build_result')`, [artifact, RUN_ID, STAGE_ID, cohortId(23)])
      : prepared.sql.query(`INSERT INTO oakridge.artifact_acceptance
          (artifact_id,run_id,receiving_stage_instance_id,output_name,artifact_type)
          VALUES ($1,$2,$3,'build_result','dev.build_result')`, [artifact, RUN_ID, STAGE_ID]);
    await insertAcceptance(artifactId(23));
    await expect(insertAcceptance(artifactId(24))).rejects.toMatchObject({ code: "23505" });
  } finally { await prepared.sql.close(); }
});

test("a failed retry launch leaves its transition and earlier attempt untouched", async () => {
  const prepared = await prepare("oakridge_v15_atomic_retry_launch");
  if (!prepared) return;
  try {
    await openCohort(prepared.sql, RETRY_STAGE_ID, cohortId(24), "retry");
    await startAttempt(prepared.sql, { stage: RETRY_STAGE_ID, cohort: cohortId(24), attempt: attemptId(25), number: 1,
      status: "failed", request: { execution_id: attemptId(25), stage_instance_id: RETRY_STAGE_ID, unit_id: "retry",
        executor_type: "delegated_session", resolved_config: { rendered_prompt: "go",
          publication: { base_url: "http://127.0.0.1:1", work_order_id: attemptId(25), capability: "cap" } },
        inputs: [], declared_outputs: [{ name: "build_result", artifact_type: "dev.build_result", required: true }],
        expected_artifacts: [{ unit_id: "retry", output_name: "build_result", artifact_type: "dev.build_result" }] } });
    await prepared.sql.query(`CREATE FUNCTION oakridge.reject_second_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.attempt_number=2 THEN RAISE EXCEPTION 'injected attempt insert failure'; END IF; RETURN NEW; END $$`, []);
    await prepared.sql.query(`CREATE TRIGGER reject_second_attempt BEFORE INSERT ON oakridge.attempt
      FOR EACH ROW EXECUTE FUNCTION oakridge.reject_second_attempt()`, []);
    await expect(launchReplacement(prepared.records, cohortId(24), RETRY_STAGE_ID,
      attemptIdFor(cohortId(24), 2), "retry-atomic"))
      .rejects.toThrow("injected attempt insert failure");
    const rows = await prepared.sql.query<{ readonly version: string; readonly transitions: string; readonly earlier_status: string }>(
      `SELECT cohort.durable_version::text AS version,
        (SELECT count(*)::text FROM oakridge.run_transition WHERE owner_cohort_id=cohort.id) AS transitions,
        (SELECT status::text FROM oakridge.attempt WHERE id=$2) AS earlier_status
       FROM oakridge.cohort cohort WHERE cohort.id=$1`, [cohortId(24), attemptId(25)]);
    expect(rows[0]).toEqual({ version: "0", transitions: "0", earlier_status: "failed" });
  } finally { await prepared.sql.close(); }
});

test("concurrent publishes from two attempts of one cohort park exactly one revision", async () => {
  const prepared = await prepare("oakridge_v15_concurrent_publish_slot");
  if (!prepared) return;
  try {
    await openCohort(prepared.sql, STAGE_ID, cohortId(25), "shared");
    await startAttempt(prepared.sql, { stage: STAGE_ID, cohort: cohortId(25), attempt: attemptId(26),
      number: 1, status: "active", request: {} });
    await startAttempt(prepared.sql, { stage: STAGE_ID, cohort: cohortId(25), attempt: attemptId(27),
      number: 2, status: "active", request: {} });
    const results = await Promise.all([
      publish(prepared, attemptId(26), artifactId(26)),
      publish(prepared, attemptId(27), artifactId(27)),
    ]);
    expect(results.map((result) => result.kind).sort()).toEqual(["published", "refused"]);
    const rows = await prepared.sql.query<{ readonly count: string }>(
      "SELECT count(*)::text AS count FROM oakridge.wait_gate WHERE cohort_id=$1 AND status='open'", [cohortId(25)]);
    expect(rows[0]?.count).toBe("1");
  } finally { await prepared.sql.close(); }
});

test("same-key retries on two executors create one attempt and one transition", async () => {
  const prepared = await prepare("oakridge_v15_same_key_retry");
  if (!prepared) return;
  try {
    await openCohort(prepared.sql, RETRY_STAGE_ID, cohortId(26), "same-key");
    await startAttempt(prepared.sql, { stage: RETRY_STAGE_ID, cohort: cohortId(26), attempt: attemptId(28), number: 1,
      status: "failed", request: { execution_id: attemptId(28), stage_instance_id: RETRY_STAGE_ID, unit_id: "same-key",
        executor_type: "delegated_session", resolved_config: { rendered_prompt: "go",
          publication: { base_url: "http://127.0.0.1:1", work_order_id: attemptId(28), capability: "cap" } },
        inputs: [], declared_outputs: [{ name: "build_result", artifact_type: "dev.build_result", required: true }],
        expected_artifacts: [{ unit_id: "same-key", output_name: "build_result", artifact_type: "dev.build_result" }] } });
    const secondSql = PgPostgresExecutor.connect(prepared.url);
    const secondWriter = new PostgresRunRecordWriter(secondSql, createDevFlowAdapterRegistry());
    const secondEvents = new StageEventApplier({ sql: secondSql, writer: secondWriter,
      registry: new StageMachineRegistry(), registered_effects: new Map(),
      load_stage_inputs: async () => ({}), start_effects: async () => {}, now: () => "2026-09-29T00:00:00.000Z" });
    const secondRecords = new PostgresRunRecordRepository(secondSql, secondWriter, secondEvents);
    const retries = await Promise.all([
      launchReplacement(prepared.records, cohortId(26), RETRY_STAGE_ID,
        attemptIdFor(cohortId(26), 2), "retry-same"),
      launchReplacement(secondRecords, cohortId(26), RETRY_STAGE_ID,
        attemptIdFor(cohortId(26), 2), "retry-same"),
    ]);
    await secondSql.close();
    expect(retries.every((result) => result.ok)).toBe(true);
    if (retries[0]?.ok && retries[1]?.ok) {
      expect(retries[0].value.attempt_id).toBe(retries[1].value.attempt_id);
      expect([retries[0].value.durable_version, retries[1].value.durable_version]).toEqual([1, 1]);
    }
    const rows = await prepared.sql.query<{ readonly attempts: string; readonly transitions: string }>(
      `SELECT (SELECT count(*)::text FROM oakridge.attempt WHERE cohort_id=$1 AND idempotency_key='retry-same') AS attempts,
        (SELECT count(*)::text FROM oakridge.run_transition WHERE owner_cohort_id=$1 AND launch_reason='retry') AS transitions`, [cohortId(26)]);
    expect(rows[0]).toEqual({ attempts: "1", transitions: "1" });
  } finally { await prepared.sql.close(); }
});

test("resolving a thread and binding a session move the invalidation cursor", async () => {
  const prepared = await prepare("oakridge_v15_cursor_updates");
  if (!prepared) return;
  try {
    await prepared.sql.query("CREATE SCHEMA dbos", []);
    await prepared.sql.query("CREATE TABLE dbos.workflow_status (updated_at timestamptz)", []);
    await openCohort(prepared.sql, STAGE_ID, cohortId(27), "cursor");
    await prepared.sql.query(`INSERT INTO oakridge.artifact (id,chain_id,revision,artifact_type,body)
      VALUES ($1,$1,1,'dev.build_result','{}')`, [artifactId(29)]);
    const thread_id = "00000000-0000-4000-8400-000000000529" as import("../src/domain/collaboration").ThreadId;
    await prepared.sql.query(`INSERT INTO oakridge.artifact_thread (id,chain_id,artifact_id,status)
      VALUES ($1,$2,$2,'open')`, [thread_id, artifactId(29)]);
    const operator = new PostgresOperatorProjectionRepository(prepared.sql, "test", createDevFlowAdapterRegistry());
    const beforeThread = await operator.get_invalidation_cursor();
    await new PostgresCollaborationRepository(prepared.sql).update_thread_status(thread_id, "resolved");
    const afterThread = await operator.get_invalidation_cursor();
    expect(afterThread).not.toBe(beforeThread);

    const writer = new PostgresRunRecordWriter(prepared.sql, createDevFlowAdapterRegistry());
    const transition = await writer.commit({ run_id: RUN_ID, owner: { kind: "cohort", id: cohortId(27) },
      expected_version: 0, launch_reason: "initial",
      change: { status: "active", blocked_reason: null, next_actor: "agent", outcome: null },
      effect: { kind: "start_attempt", cohort_id: cohortId(27), attempt_id: attemptId(29), attempt_number: 1 },
      actor: "test", changed_at: "2026-09-29T01:00:00Z" });
    if (!transition.ok) throw new Error(JSON.stringify(transition.error));
    const session_id = "00000000-0000-4000-8400-000000000629" as SessionId;
    await prepared.records.start_attempt({ run_id: RUN_ID, stage_instance_id: STAGE_ID, cohort_id: cohortId(27),
      attempt_id: attemptId(29), attempt_number: 1, adapter_type: "delegated_session", request: {} as never,
      launch_transition_id: transition.value.transition_id, session_id, idempotency_key: null,
      created_at: "2026-09-29T01:00:00Z" });
    const beforeBind = await operator.get_invalidation_cursor();
    await prepared.records.bind_session({ session_id,
      adapter_reference: { kind: "kbbl_session", session_id: "cursor-session" as never },
      kbbl_session_id: "cursor-session" as never, bound_at: "2026-09-29T01:01:00Z" });
    expect(await operator.get_invalidation_cursor()).not.toBe(beforeBind);
  } finally { await prepared.sql.close(); }
});
