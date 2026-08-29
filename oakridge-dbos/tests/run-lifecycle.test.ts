import { expect, test } from "bun:test";

import type { WorkflowRunId } from "../src/domain/primitives";
import { createRunLifecycleApp } from "../src/http/run-lifecycle";
import type { RunRecordRepository } from "../src/storage/repositories";

const runId = "00000000-0000-4000-8000-000000000001" as WorkflowRunId;

test("terminal run deletion is idempotent", async () => {
  const app = createRunLifecycleApp({ records: { delete_run: async () => ({ kind: "deleted", run_id: runId }) } as unknown as RunRecordRepository });
  expect((await app.request(`/workflow_runs/${runId}`, { method: "DELETE" })).status).toBe(204);
});

test("active run deletion returns a typed conflict", async () => {
  const app = createRunLifecycleApp({ records: { delete_run: async () => ({ kind: "active_conflict", run_id: runId, detail: "run is active" }) } as unknown as RunRecordRepository });
  const response = await app.request(`/workflow_runs/${runId}`, { method: "DELETE" });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ kind: "active_conflict", run_id: runId, detail: "run is active" });
});
