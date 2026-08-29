import { DBOSClient } from "@dbos-inc/dbos-sdk";

import { err, ok, type Result } from "../domain/primitives";
import type { RunLaunchDbosClient, RunStartError, RunStartRequest } from "./run-launch-notifications";

export class DbosRunLaunchClient implements RunLaunchDbosClient {
  constructor(private readonly client: DBOSClient) {}

  async start_v2_run(request: RunStartRequest): Promise<Result<void, RunStartError>> {
    try {
      await this.client.enqueuePortable({ queueName: "_dbos_internal_queue", workflowName: "oakridgeV2RunWorkflow",
        workflowID: request.workflow_id, appVersion: request.application_version }, [request.run_id]);
      return ok(undefined);
    } catch (error) {
      return err({ operation: "start_v2_run", workflow_id: request.workflow_id, run_id: request.run_id,
        detail: error instanceof Error ? error.message : String(error) });
    }
  }
}
