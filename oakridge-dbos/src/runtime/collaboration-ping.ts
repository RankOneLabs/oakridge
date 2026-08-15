import type { DBOSClient } from "@dbos-inc/dbos-sdk";

import type { CollaborationPingAccepted, CollaborationPingRequest } from "../domain/collaboration";

export interface CollaborationPingClient {
  enqueue(input: CollaborationPingRequest): Promise<CollaborationPingAccepted>;
}

export class DbosCollaborationPingClient implements CollaborationPingClient {
  constructor(private readonly client: DBOSClient, private readonly application_version: string) {}

  async enqueue(input: CollaborationPingRequest): Promise<CollaborationPingAccepted> {
    const workflowId = `oakridge-collaboration-ping:${input.thread_id}:${input.request_id}`;
    await this.client.enqueuePortable({
      queueName: "_dbos_internal_queue",
      workflowName: "oakridgeCollaborationResponderWorkflow",
      workflowID: workflowId,
      appVersion: this.application_version,
    }, [input]);
    return { kind: "accepted", request_id: input.request_id, workflow_id: workflowId };
  }
}
