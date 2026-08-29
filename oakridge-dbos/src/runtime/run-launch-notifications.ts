import { randomUUID } from "node:crypto";

import type { WorkflowRunRepository } from "../storage/repositories";
import type { Result, RootWorkflowId, WorkflowRunId } from "../domain/primitives";

export interface RunStartRequest {
  readonly workflow_id: RootWorkflowId;
  readonly run_id: WorkflowRunId;
  readonly application_version?: string;
}

export interface RunStartError {
  readonly operation: "start_v2_run";
  readonly workflow_id: RootWorkflowId;
  readonly run_id: WorkflowRunId;
  readonly detail: string;
}

export interface RunLaunchDbosClient {
  start_v2_run(request: RunStartRequest): Promise<Result<void, RunStartError>>;
}

const dispatchPendingRunLaunches = async (
  repository: WorkflowRunRepository,
  start: (request: RunStartRequest) => Promise<Result<void, RunStartError>>,
  now: () => string = () => new Date().toISOString(),
): Promise<number> => {
  const workerId = randomUUID();
  let delivered = 0;
  for (;;) {
    const claimedAt = now();
    const claimedUntil = new Date(Date.parse(claimedAt) + 30_000).toISOString();
    const launches = await repository.claim_pending_launches(workerId, claimedAt, claimedUntil, 100);
    for (const launch of launches) {
      try {
        const result = await start({ workflow_id: launch.target_workflow_id as RootWorkflowId, run_id: launch.command.run_id,
          ...(launch.command.application_version ? { application_version: launch.command.application_version } : {}) });
        if (!result.ok) throw new Error(`${result.error.operation}:${result.error.workflow_id}:${result.error.detail}`);
        await repository.mark_launch_delivered(launch.id, workerId, now());
        delivered += 1;
      } catch (error) {
        const failedAt = now();
        await repository.mark_launch_failed(launch.id, workerId, error instanceof Error ? error.message : String(error),
          new Date(Date.parse(failedAt) + 5_000).toISOString());
      }
    }
    if (launches.length < 100) return delivered;
  }
};

/** The only dispatcher. Its workflow name cannot replay a legacy history. */
export const dispatchRunLaunches = (repository: WorkflowRunRepository, dbos: RunLaunchDbosClient, now?: () => string): Promise<number> =>
  dispatchPendingRunLaunches(repository, (request) => dbos.start_v2_run(request), now);
