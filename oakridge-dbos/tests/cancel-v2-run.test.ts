import { expect, test } from "bun:test";

import type { ExecutorAdapter } from "../src/domain/execution";
import type { WorkOrderId, WorkflowRunId } from "../src/domain/primitives";
import { cancelV2Run } from "../src/runtime/cancel-v2-run";

test("v2 cancellation commits domain truth before best-effort executor fencing", async () => {
  const events: string[] = [];
  const workOrderId = "11111111-1111-4111-8111-111111111111" as WorkOrderId;
  const adapter: ExecutorAdapter = { executor_type: "delegated_session", async start_or_attach() { return { kind: "none" }; },
    async observe_terminal() { return { kind: "pending" }; }, async deliver_input() {},
    async cancel_or_fence() { events.push("fenced"); } };
  const result = await cancelV2Run("22222222-2222-4222-8222-222222222222" as WorkflowRunId, {
    records: {
      async cancel_run(input) { events.push("committed"); return { kind: "cancelled", run_id: input.run_id, record_version: 4 as never,
        work_orders_to_fence: [{ work_order_id: workOrderId, executor_type: adapter.executor_type, external_reference: { kind: "none" } }] }; },
      async observe_executor(_id, health) { events.push(`observed:${health.kind}`); },
    },
    find_executor: () => adapter, now: () => "2026-08-29T00:00:00Z",
  }, "operator request");
  expect(result.kind).toBe("cancelled");
  expect(events).toEqual(["committed", "fenced", "observed:ended_cancelled"]);
});

test("a fencing failure remains diagnostic and cannot roll back cancellation", async () => {
  const observed: string[] = [];
  const result = await cancelV2Run("22222222-2222-4222-8222-222222222222" as WorkflowRunId, {
    records: {
      async cancel_run(input) { return { kind: "cancelled", run_id: input.run_id, record_version: 4 as never,
        work_orders_to_fence: [{ work_order_id: "11111111-1111-4111-8111-111111111111" as WorkOrderId, executor_type: "missing", external_reference: { kind: "none" } }] }; },
      async observe_executor(_id, health) { observed.push(health.kind); },
    }, find_executor: () => undefined, now: () => "2026-08-29T00:00:00Z",
  });
  expect(result.kind).toBe("cancelled");
  expect(observed).toEqual(["unresponsive"]);
});
