import { DBOSClient } from "@dbos-inc/dbos-sdk";

import type { RunWorkflowInput } from "../workflows/production-topology";
import type { WorkflowRunId } from "../domain/primitives";
import type { StageRerunDbosClient } from "./stage-rerun";

export class DbosStageRerunClient implements StageRerunDbosClient {
  constructor(private readonly client: DBOSClient) {}

  async start_run(workflow_id: string, input: RunWorkflowInput, application_version?: string): Promise<void> {
    await this.client.enqueuePortable({ queueName: "_dbos_internal_queue", workflowName: "oakridgeProductionRunWorkflow",
      workflowID: workflow_id, appVersion: application_version }, [input]);
  }

  async start_v2_run(workflow_id: string, run_id: WorkflowRunId, application_version?: string): Promise<void> {
    await this.client.enqueuePortable({ queueName: "_dbos_internal_queue", workflowName: "oakridgeV2RunWorkflow",
      workflowID: workflow_id, appVersion: application_version }, [run_id]);
  }
}
