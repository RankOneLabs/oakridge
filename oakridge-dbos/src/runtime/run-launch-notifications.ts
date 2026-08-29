import { randomUUID } from "node:crypto";

import type { WorkflowRunRepository } from "../storage/repositories";
import type { WorkflowRunId } from "../domain/primitives";

export interface RunLaunchDbosClient {
  start_v2_run(workflow_id: string, run_id: WorkflowRunId, application_version?: string): Promise<void>;
}

const dispatchPendingRunLaunches = async (
  repository: WorkflowRunRepository,
  start: (workflow_id: string, run_id: WorkflowRunId, application_version: string | undefined) => Promise<void>,
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
        await start(launch.target_workflow_id, launch.command.run_id, launch.command.application_version ?? undefined);
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
  dispatchPendingRunLaunches(repository, (workflow_id, run_id, application_version) => dbos.start_v2_run(workflow_id, run_id, application_version), now);
