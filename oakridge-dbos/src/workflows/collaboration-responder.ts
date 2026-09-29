import { DBOS } from "@dbos-inc/dbos-sdk";

import type { DeliverSessionMessage, SessionMessageDeliveryResult, SessionMessageRepository } from "../domain/collaboration";
import { findExecutorAdapter } from "../runtime/executor-registry";

let messages: SessionMessageRepository | null = null;

export const registerSessionMessageRepository = (repository: SessionMessageRepository): void => { messages = repository; };

const requireMessages = (): SessionMessageRepository => {
  if (!messages) throw new Error("session message repository is not registered");
  return messages;
};

const deliverCollaborationInputStep = DBOS.registerStep(async (input: DeliverSessionMessage): Promise<void> => {
  const adapter = findExecutorAdapter(input.target.executor_type);
  if (!adapter) throw new Error(`executor adapter '${input.target.executor_type}' is not registered`);
  await adapter.deliver_input(input.target.execution_id, input.message.delivery_key, input.prompt, input.target.external_reference);
}, { name: "oakridgeDeliverCollaborationInputStep", retriesAllowed: true });

const recordDeliveryResultStep = DBOS.registerStep(async (
  messageId: DeliverSessionMessage["message"]["id"],
  result: SessionMessageDeliveryResult,
  recordedAt: string,
): Promise<void> => { await requireMessages().record_delivery_result(messageId, result, recordedAt); },
{ name: "oakridgeRecordSessionMessageDeliveryStep", retriesAllowed: true });

export const collaborationResponderWorkflow = DBOS.registerWorkflow(async (input: DeliverSessionMessage): Promise<void> => {
  try {
    await deliverCollaborationInputStep(input);
  } catch (error) {
    const failedAt = new Date(await DBOS.now()).toISOString();
    await recordDeliveryResultStep(input.message.id, {
      kind: "failed", detail: error instanceof Error ? error.message : String(error),
    }, failedAt);
    throw error;
  }
  await recordDeliveryResultStep(input.message.id, { kind: "delivered" }, new Date(await DBOS.now()).toISOString());
}, { name: "oakridgeCollaborationResponderWorkflow" });
