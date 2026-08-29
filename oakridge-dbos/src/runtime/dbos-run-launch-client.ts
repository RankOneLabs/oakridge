import { DBOSClient } from "@dbos-inc/dbos-sdk";

import type { WorkflowRunId } from "../domain/primitives";
import type { RunLaunchDbosClient } from "./run-launch-notifications";

export class DbosRunLaunchClient implements RunLaunchDbosClient {
  constructor(private readonly client: DBOSClient) {}

  async start_v2_run(workflow_id: string, run_id: WorkflowRunId, application_version?: string): Promise<void> {
    await this.client.enqueuePortable({ queueName: "_dbos_internal_queue", workflowName: "oakridgeV2RunWorkflow",
      workflowID: workflow_id, appVersion: application_version }, [run_id]);
  }
}
