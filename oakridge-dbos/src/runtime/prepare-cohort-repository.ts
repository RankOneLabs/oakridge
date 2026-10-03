import { existsSync } from "node:fs";
import type { ImplementationCohortInputs } from "../domain/dev-flow-v15";
import { err, ok, type CohortId, type Result } from "../domain/primitives";
import type { GitCommandRunner } from "../domain/repository-provisioning";
import type { SqlExecutor } from "../storage/sql-executor";
import type { DevFlowPullRequestRepository } from "../storage/repositories";
import { prepareDevFlowBuildCohort } from "./cohort-pull-request";
import { prepareFinalIntegrationWorktree } from "./final-integration";
export interface CohortPreparationDependencies { readonly sql: SqlExecutor; readonly git: GitCommandRunner;
  readonly pull_requests: DevFlowPullRequestRepository; readonly now: () => string }
/** Preparation is IO; the decision owner receives only its verified frozen repository facts. */
export const prepareCohortRepository = async (dependencies: CohortPreparationDependencies, cohort_id: CohortId):
  Promise<Result<void, { readonly detail: string }>> => {
      const rows = await dependencies.sql.query<{ readonly stage_instance_id: import("../domain/primitives").StageInstanceId;
        readonly stage_key: string; readonly cohort_key: string; readonly state: string; readonly has_definition: boolean; readonly frozen_inputs: ImplementationCohortInputs }>(
        `SELECT cohort.stage_instance_id::text,stage.stage_key,cohort.cohort_key,cohort.state,cohort.frozen_inputs,stage.stage_contract ? 'cohort' AS has_definition
         FROM oakridge.cohort cohort JOIN oakridge.stage_instance stage ON stage.id=cohort.stage_instance_id
         WHERE cohort.id=$1`, [cohort_id]);
      const row = rows[0];
      if (!row) return err({ detail: "implementation cohort is missing" });
      if (!row.has_definition) return ok(undefined);
      if (row.stage_key === "final_integration") return prepareFinalIntegrationWorktree({ sql: dependencies.sql, git: dependencies.git }, cohort_id);
      if (row.stage_key !== "implementation") return ok(undefined);
      if (row.state === "awaiting_merge" || row.state === "complete" || row.state === "failed" || row.state === "cancelled")
        return ok(undefined);
      const repository = row.frozen_inputs.repository;
      if (repository.worktree_base_sha) return existsSync(repository.worktree_path)
        ? ok(undefined) : err({ detail: "prepared cohort worktree is missing" });
      const prepared = await prepareDevFlowBuildCohort({ pull_requests: dependencies.pull_requests, git: dependencies.git }, {
        cohort_id, stage_instance_id: row.stage_instance_id, cohort_key: row.cohort_key,
        repository: row.frozen_inputs.repository.refs, prepared_at: dependencies.now(),
      });
      if (!prepared.ok) return err({ detail: prepared.error.detail });
      if (prepared.value.cohort.canonical_ref !== repository.canonical_branch
        || prepared.value.cohort.expected_pr_base !== repository.expected_pr_base)
        return err({ detail: "prepared cohort branch disagrees with the frozen repository input" });
      if (existsSync(repository.worktree_path)) {
        const branch = await dependencies.git.run(repository.worktree_path, ["rev-parse", "--abbrev-ref", "HEAD"]);
        const ancestry = await dependencies.git.run(repository.worktree_path,
          ["merge-base", "--is-ancestor", prepared.value.worktree_base_sha, "HEAD"]);
        if (branch.exit_code !== 0 || branch.stdout.trim() !== repository.canonical_branch || ancestry.exit_code !== 0)
          return err({ detail: "prepared worktree does not match the cohort branch and observed base" });
      } else {
        const created = await dependencies.git.run(repository.refs.repository_path, ["worktree", "add", "--no-track", "-b",
          repository.canonical_branch, repository.worktree_path, prepared.value.worktree_base_sha]);
        if (created.exit_code !== 0) return err({ detail: created.stderr.trim() || "could not create the cohort worktree" });
      }
      await dependencies.sql.query(`UPDATE oakridge.cohort SET frozen_inputs=jsonb_set(frozen_inputs,
        '{repository,worktree_base_sha}',to_jsonb($2::text))
        WHERE id=$1 AND frozen_inputs #>> '{repository,worktree_base_sha}' IS NULL`,
      [cohort_id, prepared.value.worktree_base_sha]);
      return ok(undefined);
};
