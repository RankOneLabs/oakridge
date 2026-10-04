import { expect, test } from "bun:test";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { createScratchDatabase } from "./support/durable-database";
import type { WorkflowRunId } from "../src/domain/primitives";
import type { RunRecordRepository } from "../src/storage/repositories";
import { registerRunRecordWorkflowServices, runMachineWorkflow, type RunRecordWorkflowServices } from "../src/workflows/run-record-topology";

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
