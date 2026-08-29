import { randomUUID } from "node:crypto";

import type { WorkflowRunRepository } from "../storage/repositories";
import type { WorkflowRunId } from "../domain/primitives";
import type { StageRerunDbosClient } from "./stage-rerun";

export interface RunLaunchDbosClient {
  start_v2_run(workflow_id: string, run_id: WorkflowRunId, application_version?: string): Promise<void>;
}

const dispatchPendingRunLaunches = async (
  repository: WorkflowRunRepository,
  start: (workflow_id: string, run_id: WorkflowRunId, application_version: string | undefined, command: Parameters<StageRerunDbosClient["start_run"]>[1]) => Promise<void>,
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
        await start(launch.target_workflow_id, launch.command.run_id, launch.command.application_version ?? undefined, {
          run_id: launch.command.run_id, workflow_definition_id: launch.command.workflow_definition_id,
          workflow_definition_version: launch.command.workflow_definition_version, context: launch.command.context,
          created_at: launch.command.created_at, forked_from_root_workflow_id: null,
        });
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

/** Existing public dispatcher; Slice 6c removes it when the cutover becomes atomic. */
export const dispatchRunLaunches = (repository: WorkflowRunRepository, dbos: StageRerunDbosClient, now?: () => string): Promise<number> =>
  dispatchPendingRunLaunches(repository, (workflow_id, _run_id, application_version, command) => dbos.start_run(workflow_id, command, application_version), now);

/** V2 dispatcher, deliberately separate so its workflow name can never replay a legacy history. */
export const dispatchV2RunLaunches = (repository: WorkflowRunRepository, dbos: RunLaunchDbosClient, now?: () => string): Promise<number> =>
  dispatchPendingRunLaunches(repository, (workflow_id, run_id, application_version) => dbos.start_v2_run(workflow_id, run_id, application_version), now);
