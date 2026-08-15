import { expect, test } from "bun:test";

import type { ExecutionId, WorkflowRunId } from "../src/domain/primitives";
import { cancelRun, type CancelRunDependencies } from "../src/runtime/cancel-run";

test("run cancellation durably fences projected external work before recursively cancelling DBOS", async () => {
  const calls: string[] = [];
  const dependencies = { attempts: { async list_for_run() { return [{ root_workflow_id: "root-1", run_id: "run-1", forked_from_root_workflow_id: null, created_at: "now" }]; } },
    targets: { async list_for_attempt() { return [{ execution_id: "execution-1" as ExecutionId, executor_type: "delegated_session", external_reference: { kind: "kbbl_session", session_id: "session-1" } as const }]; },
      async finish_started_stages(workflowId: string) { calls.push(`finish:${workflowId}`); } },
    dbos: { async fence_execution(workflowId: string) { calls.push(`fence:${workflowId}`); }, async cancel_workflow(workflowId: string, children: boolean) { calls.push(`cancel:${workflowId}:${children}`); } },
    now: () => "2026-08-14T00:00:00Z",
  } as unknown as CancelRunDependencies;
  expect(await cancelRun("run-1" as WorkflowRunId, dependencies)).toEqual({ root_workflow_id: "root-1" });
  expect(calls).toEqual(["fence:root-1:cancel:execution-1", "cancel:root-1:true", "finish:root-1"]);
});
