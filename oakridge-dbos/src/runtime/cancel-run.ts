import type { WorkflowRunId } from "../domain/primitives";
import type { WorkflowAttemptRepository } from "../storage/repositories";

export interface CancellationDbosClient {
  cancel_attempt(control_workflow_id: string, root_workflow_id: string, reason: string | null, requested_at: string): Promise<void>;
}

export interface CancelRunDependencies {
  readonly attempts: WorkflowAttemptRepository;
  readonly dbos: CancellationDbosClient;
  readonly now: () => string;
}

export const cancelAttempt = async (root_workflow_id: string, dependencies: Pick<CancelRunDependencies, "dbos" | "now">,
  reason: string | null = null): Promise<void> => {
  await dependencies.dbos.cancel_attempt(`oakridge-cancel:${root_workflow_id}`, root_workflow_id, reason, dependencies.now());
};

export const cancelRun = async (run_id: WorkflowRunId, dependencies: CancelRunDependencies, reason: string | null = null): Promise<{ readonly root_workflow_id: string }> => {
  const attempts = await dependencies.attempts.list_for_run(run_id);
  const current = attempts[attempts.length - 1];
  if (!current) throw new Error(`workflow run '${run_id}' has no DBOS attempt`);
  await cancelAttempt(current.root_workflow_id, dependencies, reason);
  return { root_workflow_id: current.root_workflow_id };
};
