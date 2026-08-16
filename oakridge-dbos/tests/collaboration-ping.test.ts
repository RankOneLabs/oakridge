import { expect, test } from "bun:test";
import type { DBOSClient } from "@dbos-inc/dbos-sdk";

import type { CollaborationPingRequest, CollaborationPingRequestId, ThreadId } from "../src/domain/collaboration";
import type { ExecutionId } from "../src/domain/primitives";
import { DbosCollaborationPingClient } from "../src/runtime/collaboration-ping";

test("collaboration ping uses a stable DBOS workflow identity for transport retries", async () => {
  const calls: unknown[] = [];
  const dbos = { enqueuePortable: async (target: unknown, args: unknown[]) => { calls.push({ target, args }); } } as unknown as DBOSClient;
  const client = new DbosCollaborationPingClient(dbos, "app-v1");
  const input: CollaborationPingRequest = {
    thread_id: "thread-1" as ThreadId,
    request_id: "request-1" as CollaborationPingRequestId,
    execution_id: "execution-1" as ExecutionId,
    executor_type: "delegated_session",
    external_reference: { kind: "kbbl_session", session_id: "session-1" },
    prompt: "Respond to the thread",
  };
  const result = await client.enqueue(input);
  expect(result).toEqual({ kind: "accepted", request_id: input.request_id, workflow_id: "oakridge-collaboration-ping:thread-1:request-1" });
  expect(calls).toEqual([{ target: expect.objectContaining({ workflowName: "oakridgeCollaborationResponderWorkflow", workflowID: "oakridge-collaboration-ping:thread-1:request-1", appVersion: "app-v1" }), args: [input] }]);
});
