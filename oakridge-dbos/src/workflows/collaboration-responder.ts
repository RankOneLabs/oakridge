import { DBOS } from "@dbos-inc/dbos-sdk";

import type { CollaborationPingRequest, CollaborationPingState } from "../domain/collaboration";
import { findExecutorAdapter } from "../runtime/executor-registry";

const deliverCollaborationInputStep = DBOS.registerStep(async (input: CollaborationPingRequest): Promise<void> => {
  const adapter = findExecutorAdapter(input.executor_type);
  if (!adapter) throw new Error(`executor adapter '${input.executor_type}' is not registered`);
  await adapter.deliver_input(input.execution_id, `collaboration:${input.thread_id}:${input.request_id}`, input.prompt, input.external_reference);
}, { name: "oakridgeDeliverCollaborationInputStep", retriesAllowed: true });

export const collaborationResponderWorkflow = DBOS.registerWorkflow(async (input: CollaborationPingRequest): Promise<void> => {
  await DBOS.setEvent("collaboration-ping-state", { kind: "delivering", thread_id: input.thread_id, request_id: input.request_id } satisfies CollaborationPingState);
  await deliverCollaborationInputStep(input);
  await DBOS.setEvent("collaboration-ping-state", { kind: "delivered", thread_id: input.thread_id, request_id: input.request_id } satisfies CollaborationPingState);
}, { name: "oakridgeCollaborationResponderWorkflow" });
