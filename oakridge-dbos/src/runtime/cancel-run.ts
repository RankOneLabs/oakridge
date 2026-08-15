import type { WorkflowRunId } from "../domain/primitives";
import type { CancellationTargetRepository, WorkflowAttemptRepository } from "../storage/repositories";
import type { CancellationExecutionTarget } from "../domain/rerun";

export interface CancellationDbosClient {
  fence_execution(workflow_id: string, target: CancellationExecutionTarget): Promise<void>;
  cancel_workflow(workflow_id: string, cancel_children: boolean): Promise<void>;
}

export interface CancelRunDependencies {
  readonly attempts: WorkflowAttemptRepository;
  readonly targets: CancellationTargetRepository;
  readonly dbos: CancellationDbosClient;
  readonly now: () => string;
}

export const cancelAttempt = async (root_workflow_id: string, dependencies: Omit<CancelRunDependencies, "attempts">,
  reason: string | null = null): Promise<void> => {
  const targets = await dependencies.targets.list_for_attempt(root_workflow_id);
  await Promise.all(targets.map((target) => dependencies.dbos.fence_execution(`${root_workflow_id}:cancel:${target.execution_id}`, target)));
  await dependencies.dbos.cancel_workflow(root_workflow_id, true);
  await dependencies.targets.finish_started_stages(root_workflow_id, dependencies.now(), reason);
};

export const cancelRun = async (run_id: WorkflowRunId, dependencies: CancelRunDependencies, reason: string | null = null): Promise<{ readonly root_workflow_id: string }> => {
  const attempts = await dependencies.attempts.list_for_run(run_id);
  const current = attempts[attempts.length - 1];
  if (!current) throw new Error(`workflow run '${run_id}' has no DBOS attempt`);
  await cancelAttempt(current.root_workflow_id, dependencies, reason);
  return { root_workflow_id: current.root_workflow_id };
};
