import { DBOSClient } from "@dbos-inc/dbos-sdk";

import { err, ok, type Result } from "../domain/primitives";
import { RUN_MACHINE_WORKFLOW_NAME } from "../workflows/run-record-topology";
import type { RunLaunchDbosClient, RunStartError, RunStartRequest } from "./run-launch-dispatch";

export class DbosRunLaunchClient implements RunLaunchDbosClient {
  constructor(private readonly client: DBOSClient) {}

  /**
   * Enqueues the run's root machine by the name it is *registered* under,
   * imported rather than spelled out: a literal here that drifted from the
   * registration enqueued a workflow nothing serves, and DBOS accepts that
   * happily — the row sits PENDING, the run reads as alive, and nothing ever
   * runs it.
   */
  async start_v2_run(request: RunStartRequest): Promise<Result<void, RunStartError>> {
    try {
      await this.client.enqueuePortable({ queueName: "_dbos_internal_queue", workflowName: RUN_MACHINE_WORKFLOW_NAME,
        workflowID: request.workflow_id, appVersion: request.application_version }, [request.run_id]);
      return ok(undefined);
    } catch (error) {
      return err({ operation: "start_v2_run", workflow_id: request.workflow_id, run_id: request.run_id,
        detail: error instanceof Error ? error.message : String(error) });
    }
  }
}
