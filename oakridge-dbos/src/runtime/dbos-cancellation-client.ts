import { DBOSClient } from "@dbos-inc/dbos-sdk";

import type { CancellationExecutionTarget } from "../domain/rerun";
import type { CancellationDbosClient } from "./cancel-run";

export class DbosCancellationClient implements CancellationDbosClient {
  constructor(private readonly client: DBOSClient) {}

  async fence_execution(workflow_id: string, target: CancellationExecutionTarget): Promise<void> {
    const handle = await this.client.enqueuePortable<void>({ queueName: "_dbos_internal_queue", workflowName: "oakridgeExecutorFenceWorkflow", workflowID: workflow_id }, [{ execution_id: target.execution_id, executor_type: target.executor_type, ...(target.external_reference ? { external_reference: target.external_reference } : {}) }]);
    await handle.getResult();
  }

  cancel_workflow(workflow_id: string, cancel_children: boolean): Promise<void> {
    return this.client.cancelWorkflow(workflow_id, { cancelChildren: cancel_children });
  }
}
