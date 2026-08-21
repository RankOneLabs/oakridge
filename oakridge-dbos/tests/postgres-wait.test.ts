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
const SEEDED_ARTIFACTS = 8;

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
  await subject.waits.close(input.command_workflow_id, "gate", { kind: "decided", action: "approve", decision_artifact_id: null, feedback: null });
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
  await subject.waits.close(input.command_workflow_id, "gate", outcome);
  const first = await subject.waits.find_gate_wait(artifactId(7), "artifact_approval", "execution-1");
  await subject.waits.close(input.command_workflow_id, "gate", outcome);
  expect(await subject.waits.find_gate_wait(artifactId(7), "artifact_approval", "execution-1")).toEqual(first);
});

test("a close under a different outcome fails loudly", async () => {
  const subject = await fixture();
  if (!subject) return;
  const input = gateOpen(artifactId(8), "execution-1");
  await subject.waits.open_gate(input);
  await subject.waits.close(input.command_workflow_id, "gate", { kind: "decided", action: "approve", decision_artifact_id: null, feedback: null });
  await expect(subject.waits.close(input.command_workflow_id, "gate", { kind: "withdrawn" }))
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

test("close_orphaned closes every open row as withdrawn", async () => {
  const subject = await fixture();
  if (!subject) return;
  const input = gateOpen(artifactId(6), "execution-1");
  await subject.waits.open_gate(input);
  await subject.waits.close_orphaned(input.command_workflow_id, "2026-08-21T12:00:00.000Z");
  const found = await subject.waits.find_gate_wait(artifactId(6), "artifact_approval", "execution-1");
  expect(found?.status.kind === "closed" && found.status.outcome).toEqual({ kind: "withdrawn" });
});
