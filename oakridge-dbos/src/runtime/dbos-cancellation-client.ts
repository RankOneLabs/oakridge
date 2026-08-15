import { DBOSClient } from "@dbos-inc/dbos-sdk";

import type { CancellationDbosClient } from "./cancel-run";

export class DbosCancellationClient implements CancellationDbosClient {
  constructor(private readonly client: DBOSClient) {}

  async cancel_attempt(control_workflow_id: string, root_workflow_id: string, reason: string | null, requested_at: string): Promise<void> {
    const handle = await this.client.enqueuePortable<void>({ queueName: "_dbos_internal_queue", workflowName: "oakridgeCancellationControlWorkflow", workflowID: control_workflow_id }, [{ root_workflow_id, reason, requested_at }]);
    await handle.getResult();
  }
}
