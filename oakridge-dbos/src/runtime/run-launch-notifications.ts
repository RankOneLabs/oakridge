import { randomUUID } from "node:crypto";

import type { WorkflowRunRepository } from "../storage/repositories";
import type { StageRerunDbosClient } from "./stage-rerun";

export const dispatchRunLaunches = async (
  repository: WorkflowRunRepository,
  dbos: StageRerunDbosClient,
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
        await dbos.start_run(launch.target_workflow_id, {
          run_id: launch.command.run_id,
          workflow_definition_id: launch.command.workflow_definition_id,
          workflow_definition_version: launch.command.workflow_definition_version,
          context: launch.command.context,
          created_at: launch.command.created_at,
          forked_from_root_workflow_id: null,
        }, launch.command.application_version ?? undefined);
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
