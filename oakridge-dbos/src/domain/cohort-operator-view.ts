import { join } from "node:path";
import type { V15FactContext } from "../decision/stage-machine";
import type { OperatorWorkerRecord, OperatorStageUnit } from "./operator-projections";
import type { StageInstanceId } from "./primitives";
import type { CoreStatus, BlockedReason, NextActor } from "./records";
import { selectWorkerAttention } from "./worker-attention";

export interface CohortLifecycleView {
  readonly status: CoreStatus;
  readonly blocked_reason: BlockedReason | null;
  readonly next_actor: NextActor | null;
}
export const selectCohortLifecycleView = (context: V15FactContext, stored: CohortLifecycleView): CohortLifecycleView => {
  const state = context.cohort.state;
  if (state === "complete" || state === "failed" || state === "cancelled")
    return { status: state, blocked_reason: null, next_actor: null };
  if (state === "awaiting_merge") return { status: "blocked", blocked_reason: "external", next_actor: "external" };
  const attention = selectCohortWorkerRecords(context).map(selectWorkerAttention);
  if (attention.some((worker) => worker.can_retry)) return { status: "blocked", blocked_reason: "retry", next_actor: "operator" };
  if (attention.some((worker) => worker.needs_review)) return { status: "blocked", blocked_reason: "gate", next_actor: "operator" };
  return stored;
};

export interface CohortRepositoryView {
  readonly repository_key: string | null;
  readonly worktree: OperatorStageUnit["worktree"];
  readonly base_sha: string | null;
}
export const selectCohortWorkerRecords = (context: V15FactContext): readonly OperatorWorkerRecord[] => {
  switch (context.stage) {
    case "repository_preparation": return [{ worker: "provision", record: context.cohort.provision }];
    case "spec_analysis": return [{ worker: "spec", record: context.cohort.spec }];
    case "planning": return [{ worker: "plan", record: context.cohort.plan }];
    case "brief_writing": return [{ worker: "brief", record: context.cohort.brief }];
    case "implementation": return [{ worker: "build", record: context.cohort.build }, { worker: "assessment", record: context.cohort.assessment }];
    case "final_integration": return [{ worker: "final_integration", record: context.cohort.final_integration }];
  }
};
export const selectCohortRepositoryView = (context: V15FactContext, stage_id: StageInstanceId): CohortRepositoryView => {
  switch (context.stage) {
    case "repository_preparation": return { repository_key: context.cohort.inputs.repository.key, worktree: null, base_sha: null };
    case "spec_analysis": case "planning": case "brief_writing": return { repository_key: null, worktree: null, base_sha: null };
    case "implementation": {
      const repository = context.cohort.inputs.repository;
      return { repository_key: repository.refs.repository_key,
        worktree: { branch: repository.canonical_branch, path: repository.worktree_path, base_ref: repository.expected_pr_base },
        base_sha: repository.worktree_base_sha };
    }
    case "final_integration": {
      const repository = context.cohort.inputs.repository;
      return { repository_key: repository.repository_key, base_sha: null,
        worktree: { branch: repository.base_branch, base_ref: repository.integration_branch,
          path: join(repository.repository_path, ".worktrees", "oakridge", stage_id, context.cohort.key) } };
    }
  }
};
