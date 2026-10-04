import { expect, test } from "bun:test";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { createScratchDatabase } from "./support/durable-database";
import type { WorkflowRunId } from "../src/domain/primitives";
import type { RunRecordRepository } from "../src/storage/repositories";
import { registerRunRecordWorkflowServices, runMachineWorkflow, type RunRecordWorkflowServices } from "../src/workflows/run-record-topology";
import { prepareV15StageFixture } from "./support/v15-stage-fixture";
import { PostgresRunRecordRepository } from "../src/storage/postgres-run-record-repository";
import { PostgresRunRecordWriter } from "../src/storage/postgres-run-record";
import { StageEventApplier } from "../src/storage/apply-stage-event";
import { stageMachineWorkflowId } from "../src/decision/ids";

test("a lost decision-step result recovers the committed stage activation exactly once", async () => {
  const fixture = await prepareV15StageFixture();
  const workflowID = `lost-activation-${fixture.run_id}`;
  DBOS.setConfig({ name: "oakridge-lost-activation-test", systemDatabaseUrl: fixture.database_url,
    applicationVersion: "lost-activation-test", logLevel: "error" });
  try {
    await fixture.sql.query("UPDATE oakridge.stage_instance SET status='pending' WHERE id=$1", [fixture.stage_id]);
    const writer = new PostgresRunRecordWriter(fixture.sql);
    const stage_events = new StageEventApplier({ sql: fixture.sql, writer, now: () => new Date().toISOString() });
    const records = new PostgresRunRecordRepository(fixture.sql, writer, stage_events);
    const recoveringRecords: RunRecordRepository = Object.create(records);
    let calls = 0;
    recoveringRecords.decide_run = async (id, at) => {
      const result = await records.decide_run(id, at);
      if (++calls === 1) throw new Error("lost DBOS step result after stage activation committed");
      return result;
    };
    registerRunRecordWorkflowServices({ records: recoveringRecords, effects_sql: fixture.sql, stage_events,
      now: () => new Date().toISOString() });
    await DBOS.launch();
    await DBOS.startWorkflow(runMachineWorkflow, { workflowID })(fixture.run_id as WorkflowRunId);
    let initialized = false;
    for (let check = 0; check < 100; check++) {
      initialized = (await fixture.sql.query<{ readonly initialized: boolean }>(
        "SELECT initialized_at IS NOT NULL AS initialized FROM oakridge.stage_instance WHERE id=$1", [fixture.stage_id]))[0]!.initialized;
      if (initialized) break;
      await Bun.sleep(50);
    }
    expect({ initialized, retried: calls >= 2,
      stages: await fixture.sql.query("SELECT workflow_uuid FROM dbos.workflow_status WHERE name='oakridgeV15StageWorkflow'", []) })
      .toEqual({ initialized: true, retried: true, stages: [{ workflow_uuid: stageMachineWorkflowId(fixture.stage_id) }] });
  } finally {
    await DBOS.cancelWorkflow(workflowID);
    await DBOS.cancelWorkflow(stageMachineWorkflowId(fixture.stage_id));
    await DBOS.shutdown();
    await fixture.close();
  }
}, 60_000);

test("a missing run ends across the durable step boundary, including after an IO retry", async () => {
  const scratch = await createScratchDatabase("oakridge_missing_run_step_test");
  if (!scratch.ok) throw new Error(`${scratch.error.operation}: ${scratch.error.detail}`);
  const workflowIds: string[] = [];
  DBOS.setConfig({ name: "oakridge-missing-run-test", systemDatabaseUrl: scratch.value.url,
    applicationVersion: "missing-run-test", logLevel: "error" });
  try {
    await DBOS.launch();
    for (const shouldFailOnce of [false, true]) {
      let calls = 0;
      const records = { async decide_run(run_id: WorkflowRunId) {
        calls++;
        if (shouldFailOnce && calls === 1) throw new Error("temporary database outage");
        return { ok: false, error: { operation: "decide_run", run_id, kind: "run_not_found", detail: "run deleted" } };
      } } as unknown as RunRecordRepository;
      registerRunRecordWorkflowServices({ records, now: () => new Date().toISOString() } as RunRecordWorkflowServices);
      const workflowID = `missing-run-${shouldFailOnce}`;
      workflowIds.push(workflowID);
      const handle = await DBOS.startWorkflow(runMachineWorkflow, { workflowID })(
        "00000000-0000-4000-8000-000000000099" as WorkflowRunId);
      const result = await Promise.race([handle.getResult(), Bun.sleep(2500).then(() => "still_running")]);
      expect({ result, calls }).toEqual({ result: null, calls: shouldFailOnce ? 2 : 1 });
    }
  } finally {
    for (const id of workflowIds) await DBOS.cancelWorkflow(id);
    await DBOS.shutdown();
    await scratch.value.drop();
  }
}, 60_000);
