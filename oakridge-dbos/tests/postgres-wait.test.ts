import { afterAll, expect, test } from "bun:test";

import type { ArtifactId, StageInstanceId, UnitId } from "../src/domain/primitives";
import type { OpenGateWaitInput, OpenHandoffDownstreamWaitInput } from "../src/domain/wait";
import { applyMigrations } from "../src/storage/migrate";
import { PostgresWaitRepository } from "../src/storage/postgres-wait";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import { createScratchDatabase, type ScratchDatabase } from "./support/durable-database";

const STAGE = "00000000-0000-4000-8000-000000000002" as StageInstanceId;
/** One seeded artifact per test, so the open-identity index never couples them. */
const artifactId = (index: number): ArtifactId => `00000000-0000-4000-8000-0000000000a${index}` as ArtifactId;
const SEEDED_ARTIFACTS = 9;

const seed = async (sql: PgPostgresExecutor): Promise<void> => {
  await sql.query(`INSERT INTO oakridge.workflow_definition (id, name, version, definition, created_at)
    VALUES ('00000000-0000-4000-8000-000000000000', 'dev-flow', 1, '{}'::jsonb, now())`, []);
  await sql.query(`INSERT INTO oakridge.workflow_run (id, workflow_definition_id, context)
    VALUES ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000000', '{}'::jsonb)`, []);
  await sql.query(`INSERT INTO oakridge.workflow_attempt (root_workflow_id, run_id)
    VALUES ('root-1', '00000000-0000-4000-8000-000000000001')`, []);
  await sql.query(`INSERT INTO oakridge.stage_instance (id, run_id, stage_key, stage_type, stage_contract, coordinator_workflow_id, started_at, attempt_root_workflow_id)
    VALUES ($1, '00000000-0000-4000-8000-000000000001', 'build', 'fan_out', '{}'::jsonb, 'root-1:stage:build', now(), 'root-1')`, [STAGE]);
  for (let index = 1; index <= SEEDED_ARTIFACTS; index += 1) {
    await sql.query(`INSERT INTO oakridge.artifact
        (id, chain_id, run_id, stage_instance_id, execution_id, unit_id, output_name, artifact_type, body, version, emission_idempotency_key, emission_payload_hash)
      VALUES ($1, $1, '00000000-0000-4000-8000-000000000001', $2, 'stage:unit-1', 'unit-1', $3, 'dev.result', '{}'::jsonb, 1, $3, $3)`,
      [artifactId(index), STAGE, `result_${index}`]);
  }
};

interface WaitFixture { readonly sql: PgPostgresExecutor; readonly waits: PostgresWaitRepository }

const scratches: ScratchDatabase[] = [];
const connections: PgPostgresExecutor[] = [];
afterAll(async () => {
  for (const connection of connections) await connection.close();
  for (const scratch of scratches) await scratch.drop();
});

let prepared: WaitFixture | null | undefined;
const fixture = async (): Promise<WaitFixture | null> => {
  if (prepared !== undefined) return prepared;
  const scratch = await createScratchDatabase("oakridge_wait_test");
  if (!scratch.ok) {
    // A missing PostgreSQL is a skip; a refused CREATE DATABASE is not, and a
    // caller that treated them alike would report a broken environment green.
    if (scratch.error.operation !== "reach_admin_endpoint") throw new Error(`${scratch.error.operation}: ${scratch.error.detail}`);
    console.warn("wait repository tests SKIPPED: no PostgreSQL reachable");
    prepared = null;
    return prepared;
  }
  scratches.push(scratch.value);
  const sql = PgPostgresExecutor.connect(scratch.value.url);
  connections.push(sql);
  await applyMigrations(sql);
  await seed(sql);
  prepared = { sql, waits: new PostgresWaitRepository(sql) };
  return prepared;
};

const gateOpen = (artifact: ArtifactId, execution_workflow_id: string): OpenGateWaitInput => ({
  command_workflow_id: `${execution_workflow_id}:gate:${artifact}:wait:artifact_approval`,
  stage_instance_id: STAGE, unit_id: "unit-1" as UnitId, artifact_revision_id: artifact,
  execution_workflow_id, gate_step: "artifact_approval", actions: ["approve", "request_revision"],
});

const downstreamOpen = (artifact: ArtifactId, execution_workflow_id: string): OpenHandoffDownstreamWaitInput => ({
  command_workflow_id: `${execution_workflow_id}:handoff:${artifact}`,
  stage_instance_id: STAGE, unit_id: "unit-1" as UnitId, artifact_revision_id: artifact,
  execution_workflow_id, downstream_role: "assessment",
});

test("an opened gate wait is found by artifact, step, and execution", async () => {
  const subject = await fixture();
  if (!subject) return;
  const input = gateOpen(artifactId(1), "execution-1");
  await subject.waits.open_gate(input);
  expect(await subject.waits.find_gate_wait(artifactId(1), "artifact_approval", "execution-1")).toEqual(expect.objectContaining({
    command_workflow_id: input.command_workflow_id, status: { kind: "open" },
    closes_on: { kind: "gate", gate_step: "artifact_approval", actions: ["approve", "request_revision"] },
  }));
});

test("the lookup misses under a different execution workflow id", async () => {
  const subject = await fixture();
  if (!subject) return;
  await subject.waits.open_gate(gateOpen(artifactId(2), "execution-1"));
  expect(await subject.waits.find_gate_wait(artifactId(2), "artifact_approval", "execution-2")).toBeNull();
});

test("a retried open records one row", async () => {
  const subject = await fixture();
  if (!subject) return;
  await subject.waits.open_gate(gateOpen(artifactId(3), "execution-1"));
  await subject.waits.open_gate(gateOpen(artifactId(3), "execution-1"));
  const rows = await subject.sql.query<{ readonly id: string }>(
    "SELECT id::text FROM oakridge.wait WHERE artifact_revision_id = $1", [artifactId(3)]);
  expect(rows).toHaveLength(1);
});

test("a closed wait keeps its outcome on the same row", async () => {
  const subject = await fixture();
  if (!subject) return;
  const input = gateOpen(artifactId(4), "execution-1");
  await subject.waits.open_gate(input);
  await subject.waits.close(input.command_workflow_id, { kind: "gate", outcome: { kind: "decided", action: "approve", decision_artifact_id: null, feedback: null } });
  expect(await subject.waits.find_gate_wait(artifactId(4), "artifact_approval", "execution-1")).toEqual(expect.objectContaining({
    status: expect.objectContaining({ kind: "closed", outcome: { kind: "decided", action: "approve", decision_artifact_id: null, feedback: null } }),
  }));
});

test("a retried close is absorbed, keeping the first outcome and timestamp", async () => {
  const subject = await fixture();
  if (!subject) return;
  const input = gateOpen(artifactId(7), "execution-1");
  await subject.waits.open_gate(input);
  const outcome = { kind: "decided", action: "approve", decision_artifact_id: null, feedback: null } as const;
  await subject.waits.close(input.command_workflow_id, { kind: "gate", outcome });
  const first = await subject.waits.find_gate_wait(artifactId(7), "artifact_approval", "execution-1");
  await subject.waits.close(input.command_workflow_id, { kind: "gate", outcome });
  expect(await subject.waits.find_gate_wait(artifactId(7), "artifact_approval", "execution-1")).toEqual(first);
});

test("a close under a different outcome fails loudly", async () => {
  const subject = await fixture();
  if (!subject) return;
  const input = gateOpen(artifactId(8), "execution-1");
  await subject.waits.open_gate(input);
  await subject.waits.close(input.command_workflow_id, { kind: "gate", outcome: { kind: "decided", action: "approve", decision_artifact_id: null, feedback: null } });
  await expect(subject.waits.close(input.command_workflow_id, { kind: "gate", outcome: { kind: "withdrawn" } }))
    .rejects.toThrow("already closed under a different outcome");
});

test("release_downstream closes the downstream row and opens the external one in one call", async () => {
  const subject = await fixture();
  if (!subject) return;
  const input = downstreamOpen(artifactId(5), "execution-1");
  await subject.waits.open_handoff_downstream(input);
  await subject.waits.release_downstream(input.command_workflow_id,
    { kind: "decided", action: "approve", decision_artifact_id: artifactId(6), feedback: null },
    { kind: "handoff_external", external_wait_kind: "github_review", decision_artifact_id: artifactId(6) });
  const waits = await subject.waits.find_handoff_waits(artifactId(5), "execution-1");
  const downstream = waits.find((wait) => wait.closes_on.kind === "handoff_downstream");
  const external = waits.find((wait) => wait.closes_on.kind === "handoff_external");
  expect({
    downstream_status: downstream?.status.kind === "closed" ? downstream.status.outcome.kind : downstream?.status.kind,
    external_status: external?.status.kind,
    // The external row is the downstream row's continuation, so it carries the
    // same execution binding the commands will be matched against.
    external_execution: external?.execution_workflow_id,
  }).toEqual({ downstream_status: "decided", external_status: "open", external_execution: "execution-1" });
});

test("handoff rows are found by artifact revision alone, for a reader that knows no execution", async () => {
  const subject = await fixture();
  if (!subject) return;
  const input = downstreamOpen(artifactId(9), "execution-1");
  await subject.waits.open_handoff_downstream(input);
  const waits = await subject.waits.find_handoff_waits_for_artifact(artifactId(9));
  expect(waits.map((wait) => [wait.closes_on.kind, wait.status.kind, wait.execution_workflow_id])).toEqual([["handoff_downstream", "open", "execution-1"]]);
  expect(await subject.waits.find_handoff_waits_for_artifact(artifactId(3))).toEqual([]);
});

test("the schema refuses an outcome foreign to the wait's kind", async () => {
  const subject = await fixture();
  if (!subject) return;
  await subject.waits.open_gate(gateOpen(artifactId(9), "execution-1"));
  await expect(subject.sql.query(
    `UPDATE oakridge.wait SET status = 'closed', outcome = '{"kind":"external_completed","correlation_id":"x"}', closed_at = now()
     WHERE artifact_revision_id = $1 AND kind = 'gate'`, [artifactId(9)],
  )).rejects.toThrow(/check constraint/);
});

test("close_orphaned closes every open row as withdrawn", async () => {
  const subject = await fixture();
  if (!subject) return;
  const input = gateOpen(artifactId(6), "execution-1");
  await subject.waits.open_gate(input);
  await subject.waits.close_orphaned(input.command_workflow_id, "2026-08-21T12:00:00.000Z");
  const found = await subject.waits.find_gate_wait(artifactId(6), "artifact_approval", "execution-1");
  expect(found?.status.kind === "closed" && found.status.outcome).toEqual({ kind: "withdrawn" });
});

/** Seeds one fresh artifact row, for a test that needs an id outside the shared 1..9 pool. */
const seedArtifact = async (sql: PgPostgresExecutor, artifactRevisionId: string, resultName: string): Promise<void> => {
  await sql.query(
    `INSERT INTO oakridge.artifact (id, chain_id, run_id, stage_instance_id, execution_id, unit_id, output_name, artifact_type, body, version, emission_idempotency_key, emission_payload_hash)
     VALUES ($1, $1, '00000000-0000-4000-8000-000000000001', $2, 'stage:unit-1', 'unit-1', $3, 'dev.result', '{}'::jsonb, 1, $3, $3)`,
    [artifactRevisionId, STAGE, resultName],
  );
};

/** Seeds one `run_unit` row so a v2 wait's `run_unit_id` foreign key resolves. */
const seedRunUnit = async (sql: PgPostgresExecutor, runUnitId: string, unitId: string): Promise<void> => {
  await sql.query(
    `INSERT INTO oakridge.run_unit (id, run_id, stage_instance_id, unit_id, parameters, input_snapshot, input_fingerprint, state, created_at)
     VALUES ($1, '00000000-0000-4000-8000-000000000001', $2, $3, '{}'::jsonb, '[]'::jsonb, 'empty', 'working', now())`,
    [runUnitId, STAGE, unitId],
  );
};

/**
 * A legacy wait row never carries v2 identity. `RunRecordRepository` writes
 * the v2 columns directly (its own transaction owns slot + wait together), so
 * this proves the read side decodes them rather than that anyone here opens one.
 */
test("a v1 wait decodes null v2 identity", async () => {
  const subject = await fixture();
  if (!subject) return;
  const artifact = "00000000-0000-4000-8000-0000000000d0" as ArtifactId;
  await seedArtifact(subject.sql, artifact, "result_v1_decode");
  const input = gateOpen(artifact, "execution-legacy");
  await subject.waits.open_gate(input);
  const found = await subject.waits.find_gate_wait(artifact, "artifact_approval", "execution-legacy");
  expect(found).toEqual(expect.objectContaining({ run_unit_id: null, output_name: null }));
});

/** A row `RunRecordRepository` opens directly is still readable through the shared wait repository. */
test("a v2-opened wait decodes its run-unit and output-slot identity", async () => {
  const subject = await fixture();
  if (!subject) return;
  const artifact = "00000000-0000-4000-8000-0000000000d1" as ArtifactId;
  const runUnitId = "00000000-0000-4000-8000-0000000000b1";
  await seedArtifact(subject.sql, artifact, "result_v2_decode");
  await seedRunUnit(subject.sql, runUnitId, "unit-v2-1");
  await subject.sql.query(
    `INSERT INTO oakridge.wait (id, stage_instance_id, unit_id, kind, artifact_revision_id, closes_on, status, run_unit_id, output_name, execution_workflow_id, command_workflow_id, opened_at)
     VALUES ('00000000-0000-4000-8000-0000000000c1', $1, 'unit-v2-1', 'gate', $2, '{"kind":"gate","gate_step":"artifact_approval","actions":["release"]}'::jsonb, 'open', $3, 'result', 'v2-work:1', 'v2-wait:1:result', now())`,
    [STAGE, artifact, runUnitId],
  );
  const found = await subject.waits.find_gate_wait(artifact, "artifact_approval", "v2-work:1");
  expect(found).toEqual(expect.objectContaining({ run_unit_id: runUnitId, output_name: "result", command_workflow_id: "v2-wait:1:result" }));
});

test("at most one open v2 wait exists per output slot", async () => {
  const subject = await fixture();
  if (!subject) return;
  const first = "00000000-0000-4000-8000-0000000000d2" as ArtifactId;
  const second = "00000000-0000-4000-8000-0000000000d3" as ArtifactId;
  const runUnitId = "00000000-0000-4000-8000-0000000000b2";
  await seedArtifact(subject.sql, first, "result_slot_race_1");
  await seedArtifact(subject.sql, second, "result_slot_race_2");
  await seedRunUnit(subject.sql, runUnitId, "unit-v2-2");
  await subject.sql.query(
    `INSERT INTO oakridge.wait (id, stage_instance_id, unit_id, kind, artifact_revision_id, closes_on, status, run_unit_id, output_name, execution_workflow_id, command_workflow_id, opened_at)
     VALUES ('00000000-0000-4000-8000-0000000000c2', $1, 'unit-v2-2', 'gate', $2, '{"kind":"gate","gate_step":"artifact_approval","actions":["release"]}'::jsonb, 'open', $3, 'result', 'v2-work:2', 'v2-wait:2:result', now())`,
    [STAGE, first, runUnitId],
  );
  await expect(subject.sql.query(
    `INSERT INTO oakridge.wait (id, stage_instance_id, unit_id, kind, artifact_revision_id, closes_on, status, run_unit_id, output_name, execution_workflow_id, command_workflow_id, opened_at)
     VALUES ('00000000-0000-4000-8000-0000000000c3', $1, 'unit-v2-2', 'gate', $2, '{"kind":"gate","gate_step":"artifact_approval","actions":["release"]}'::jsonb, 'open', $3, 'result', 'v2-work:2', 'v2-wait:2:result:retry', now())`,
    [STAGE, second, runUnitId],
  )).rejects.toThrow(/duplicate key value/);
});
