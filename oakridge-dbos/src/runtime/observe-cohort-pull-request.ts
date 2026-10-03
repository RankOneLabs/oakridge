import type { VerifiedPrObservation } from "../domain/dev-flow-v15";
import { ok, type CohortId, type CommitSha, type RepositoryKey, type Result, type StageInstanceId, type UnitId, type WorkflowRunId } from "../domain/primitives";
import type { GitCommandRunner } from "../domain/repository-provisioning";
import type { DevFlowPullRequestRepository, ForgeRepositoryRepository } from "../storage/repositories";
import type { SqlExecutor } from "../storage/sql-executor";
import { verifyCohortPullRequest } from "./cohort-pull-request";
import { observeFinalIntegrationPullRequest } from "./final-integration";
import type { PullRequestReader } from "./github-pull-requests";
export interface CohortPrObservationDependencies { readonly sql: SqlExecutor; readonly git: GitCommandRunner; readonly reader: PullRequestReader;
  readonly pull_requests: DevFlowPullRequestRepository; readonly forge_repositories: ForgeRepositoryRepository }
export const observeCohortPullRequest = async (dependencies: CohortPrObservationDependencies, cohort_id: CohortId):
  Promise<Result<VerifiedPrObservation | null, { readonly detail: string }>> => {
  const rows = await dependencies.sql.query<{ readonly run_id: WorkflowRunId; readonly stage_instance_id: StageInstanceId;
    readonly cohort_key: string; readonly stage_key: string }>(`SELECT cohort.run_id::text,cohort.stage_instance_id::text,cohort.cohort_key,stage.stage_key
     FROM oakridge.cohort cohort JOIN oakridge.stage_instance stage ON stage.id=cohort.stage_instance_id WHERE cohort.id=$1`, [cohort_id]);
  const row = rows[0];
  if (!row) return ok(null);
  if (row.stage_key === "final_integration") return observeFinalIntegrationPullRequest(dependencies, cohort_id);
  if (row.stage_key !== "implementation") return ok(null);
  const current = await dependencies.pull_requests.find_current_for_unit(row.stage_instance_id, row.cohort_key as UnitId);
  if (!current) return ok(null);
  const forge = await dependencies.forge_repositories.find_forge_repository(row.run_id, current.cohort.repository_key);
  if (!forge) return { ok: false, error: { detail: "implementation repository forge authority is missing" } };
  const verified = await verifyCohortPullRequest(dependencies, { cohort: current.cohort, forge_repository: forge, candidate_url: current.pull_request.url });
  if (!verified.ok) return verified;
  const observation = verified.value.observation;
  return ok({ pr_url: observation.url, repository_key: current.cohort.repository_key as RepositoryKey,
    head_branch: observation.head_branch, base_branch: observation.base_branch, head_sha: verified.value.pushed_head_sha as CommitSha,
    state: observation.state === "closed_unmerged" ? "closed" : observation.state });
};
