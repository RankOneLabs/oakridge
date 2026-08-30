import { randomUUID } from "node:crypto";

import { afterAll, expect, test } from "bun:test";

import type { ArtifactId, StageInstanceId } from "../src/domain/primitives";
import { applyMigrations } from "../src/storage/migrate";
import { decodeWait, waitColumns, type WaitRow } from "../src/storage/postgres-wait";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import { createScratchDatabase, type ScratchDatabase } from "./support/durable-database";

const STAGE = "00000000-0000-4000-8000-000000000002" as StageInstanceId;

const seed = async (sql: PgPostgresExecutor): Promise<void> => {
  await sql.query(`INSERT INTO oakridge.workflow_definition (id, name, version, definition, created_at)
    VALUES ('00000000-0000-4000-8000-000000000000', 'dev-flow', 1, '{}'::jsonb, now())`, []);
  await sql.query(`INSERT INTO oakridge.workflow_run (id, workflow_definition_id, context)
    VALUES ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000000', '{}'::jsonb)`, []);
  // No `workflow_attempt` row: `decodeWait` is exercised directly, and
  // `attempt_root_workflow_id` has been nullable since migration 0011 — a v2
  // stage instance is never attached to one.
  await sql.query(`INSERT INTO oakridge.stage_instance (id, run_id, stage_key, stage_type, stage_contract, coordinator_workflow_id, started_at, attempt_root_workflow_id)
    VALUES ($1, '00000000-0000-4000-8000-000000000001', 'build', 'fan_out', '{}'::jsonb, 'root-1:stage:build', now(), NULL)`, [STAGE]);
};

interface WaitFixture { readonly sql: PgPostgresExecutor }

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
  prepared = { sql };
  return prepared;
};

/** Seeds one artifact row, so a wait's `artifact_revision_id` foreign key resolves. */
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

const findByArtifact = async (sql: PgPostgresExecutor, artifact_revision_id: string) => {
  const rows = await sql.query<WaitRow>(`SELECT ${waitColumns} FROM oakridge.wait wait WHERE wait.artifact_revision_id = $1`, [artifact_revision_id]);
  const row = rows[0];
  if (!row) throw new Error(`no wait row seeded for artifact '${artifact_revision_id}'`);
  return decodeWait(row);
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
  await subject.sql.query(
    `INSERT INTO oakridge.wait (id, stage_instance_id, unit_id, kind, artifact_revision_id, closes_on, status, execution_workflow_id, command_workflow_id, opened_at)
     VALUES ($1, $2, 'unit-1', 'gate', $3, '{"kind":"gate","gate_step":"artifact_approval","actions":["approve","request_revision"]}'::jsonb, 'open', 'execution-legacy', $4, now())`,
    [randomUUID(), STAGE, artifact, `execution-legacy:gate:${artifact}:wait:artifact_approval`],
  );
  const found = await findByArtifact(subject.sql, artifact);
  expect(found).toEqual(expect.objectContaining({ run_unit_id: null, output_name: null, command_workflow_id: `execution-legacy:gate:${artifact}:wait:artifact_approval` }));
});

/** A row `RunRecordRepository` opens directly is still readable through the shared columns/decoder. */
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
  const found = await findByArtifact(subject.sql, artifact);
  expect(found).toEqual(expect.objectContaining({ run_unit_id: runUnitId, output_name: "result", command_workflow_id: "v2-wait:1:result" }));
});
