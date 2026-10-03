import { join } from "node:path";
import type { V15FactContext } from "../decision/stage-machine";
import type { OperatorWorkerRecord, OperatorStageUnit } from "./operator-projections";
import type { StageInstanceId } from "./primitives";

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
