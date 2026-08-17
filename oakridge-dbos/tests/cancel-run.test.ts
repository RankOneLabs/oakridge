import { expect, test } from "bun:test";

import type { WorkflowRunId } from "../src/domain/primitives";
import { cancelRun, type CancelRunDependencies } from "../src/runtime/cancel-run";

test("run cancellation starts one stable durable control workflow", async () => {
  const calls: string[] = [];
  const dependencies: CancelRunDependencies = {
    attempts: { async list_for_run() { return [{ root_workflow_id: "root-1", run_id: "run-1" as WorkflowRunId, forked_from_root_workflow_id: null, created_at: "now" }]; }, async insert() {}, async find_by_root_workflow_id() { return null; }, async finish() {} },
    dbos: { async cancel_attempt(controlId, rootId, reason, requestedAt) { calls.push(`${controlId}:${rootId}:${reason}:${requestedAt}`); } },
    now: () => "2026-08-14T00:00:00Z",
  };
  expect(await cancelRun("run-1" as WorkflowRunId, dependencies, "operator request")).toEqual({ root_workflow_id: "root-1" });
  expect(calls).toEqual(["oakridge-cancel:root-1:root-1:operator request:2026-08-14T00:00:00Z"]);
});

test("cancellation retry reuses the same control workflow identity", async () => {
  const ids: string[] = [];
  const dependencies: CancelRunDependencies = {
    attempts: { async list_for_run() { return [{ root_workflow_id: "root-1", run_id: "run-1" as WorkflowRunId, forked_from_root_workflow_id: null, created_at: "now" }]; }, async insert() {}, async find_by_root_workflow_id() { return null; }, async finish() {} },
    dbos: { async cancel_attempt(controlId) { ids.push(controlId); } }, now: () => "now",
  };
  await cancelRun("run-1" as WorkflowRunId, dependencies);
  await cancelRun("run-1" as WorkflowRunId, dependencies);
  expect(ids).toEqual(["oakridge-cancel:root-1", "oakridge-cancel:root-1"]);
});
