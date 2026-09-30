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
import { attemptIdFor } from "../src/decision/ids";
import type { AttemptId, CohortId, JsonValue, StageInstanceId, WorkflowRunId } from "../src/domain/primitives";
import type { WorkOrderId } from "../src/domain/primitives";
import { capabilityFor, capabilityHash } from "../src/runtime/resolve-work-order";
import { applyMigrations } from "../src/storage/migrate";
import { PostgresRunRecordWriter } from "../src/storage/postgres-run-record";
import { PostgresArtifactRepository } from "../src/storage/postgres-domain";
import { PostgresRunRecordRepository } from "../src/storage/postgres-run-record-repository";
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
const STAGE_CONTRACT: JsonValue = { stage_key: "build", outputs: [gatedOutput("build_result", "dev.build_result")] };
/** A collecting output: one cohort publishes it once per collection key. */
const COLLECTION_CONTRACT: JsonValue = { stage_key: "brief_writer", outputs: [gatedOutput("brief", "dev.build_brief")] };

const STAGES: readonly { readonly id: StageInstanceId; readonly key: string; readonly contract: JsonValue }[] = [
  { id: STAGE_ID, key: "build", contract: STAGE_CONTRACT },
  { id: RETRY_STAGE_ID, key: "build_retry", contract: STAGE_CONTRACT },
  { id: COLLECTION_STAGE_ID, key: "brief_writer", contract: COLLECTION_CONTRACT },
];

const scratches: ScratchDatabase[] = [];
afterAll(async () => { for (const scratch of scratches) await scratch.drop(); });

interface Prepared {
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
  const records = new PostgresRunRecordRepository(sql, new PostgresRunRecordWriter(sql, createDevFlowAdapterRegistry()));
  return { sql, records, seed: await records.load_work_order_capability_seed() };
};

const openCohort = async (sql: Prepared["sql"], stage: StageInstanceId, cohort: CohortId, key: string): Promise<void> => {
  await sql.query(`INSERT INTO oakridge.cohort (id,run_id,stage_instance_id,cohort_key,stage_data,status)
    VALUES ($1,$2,$3,$4,'{}','active')`, [cohort, RUN_ID, stage, key]);
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
    expect(first.kind).toBe("pending");
    expect(second.kind).toBe("pending");
    if (first.kind !== "pending" || second.kind !== "pending") return;
    expect(second.wait_id).not.toBe(first.wait_id);
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
    const released = await prepared.records.decide_gate_wait({ wait_id: first.wait_id, action: "approve",
      actor: "operator", detail: null, decided_at: "2026-09-29T00:01:00.000Z" });
    expect(released.kind).toBe("released");
    const secondState = await prepared.records.find_cohort_state(cohortId(2));
    expect(secondState?.open_waits.map((wait) => wait.wait_id)).toEqual([second.wait_id]);
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
    expect([foundation.kind, web.kind]).toEqual(["pending", "pending"]);
    if (foundation.kind !== "pending" || web.kind !== "pending") return;
    expect(web.wait_id).not.toBe(foundation.wait_id);

    const chains = await prepared.sql.query<{ readonly id: string; readonly chain_id: string; readonly revision: number; readonly lifecycle: string }>(
      `SELECT artifact.id::text,artifact.chain_id::text,artifact.revision,artifact.lifecycle
         FROM oakridge.artifact artifact
         JOIN oakridge.artifact_owner owner ON owner.artifact_id=artifact.id
        WHERE owner.cohort_id=$1 ORDER BY artifact.id`, [cohortId(8)]);
    // Two chains at revision 1, both still current: neither supersedes the other.
    expect(chains).toEqual([
      { id: artifactId(8), chain_id: artifactId(8), revision: 1, lifecycle: "current" },
      { id: artifactId(9), chain_id: artifactId(9), revision: 1, lifecycle: "current" },
    ]);

    // Both releases are visible to the downstream stage that collects them.
    for (const wait of [foundation.wait_id, web.wait_id]) {
      const released = await prepared.records.decide_gate_wait({ wait_id: wait, action: "approve",
        actor: "operator", detail: null, decided_at: "2026-09-29T00:03:00.000Z" });
      expect(released.kind).toBe("released");
    }
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

    const retried = await prepared.records.retry_cohort({
      target: { kind: "cohort", cohort_id: cohortId(5) }, actor: "operator", idempotency_key: "retry-1",
    }, "2026-09-29T00:02:00.000Z");
    expect(retried.kind).toBe("created");
    if (retried.kind !== "created") return;
    expect(retried.attempt_id).toBe(attemptIdFor(cohortId(5), 2));

    const state = await prepared.records.find_cohort_state(cohortId(5));
    expect(state?.latest_unfinished_attempt_id).toBe(retried.attempt_id);
    // The replaced attempt is not a candidate: it ended when the retry abandoned it.
    expect(state?.attempt_count).toBe(2);
  } finally {
    await prepared.sql.close();
  }
});
