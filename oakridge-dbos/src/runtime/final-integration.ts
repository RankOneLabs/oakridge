import type { CohortPreparationError } from "../domain/cohort-pull-request";
import { runExclusive } from "./keyed-mutex";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { FinalIntegrationInputs, V15RunInputs, VerifiedPrObservation } from "../domain/dev-flow-v15";
import type { PrSummaryBody } from "../domain/dev-flow-artifacts";
import type { PullRequestReader } from "./github-pull-requests";
import type { GitCommandRunner } from "../domain/repository-provisioning";
import { verifyPreparedPullRequest } from "./cohort-pull-request";
import { err, ok, type CohortId, type CommitSha, type RepositoryKey, type Result } from "../domain/primitives";
import type { SqlExecutor } from "../storage/sql-executor";

export interface FinalIntegrationVerificationDependencies { readonly sql: SqlExecutor; readonly reader: PullRequestReader; readonly git: GitCommandRunner }
interface FinalIntegrationRow { readonly frozen_inputs: FinalIntegrationInputs; readonly context: V15RunInputs }
export interface FinalIntegrationVerificationError { readonly code: "pr_verification_failed"; readonly detail: string }
export const verifyFinalIntegrationPullRequest = async (dependencies: FinalIntegrationVerificationDependencies,
  input: { readonly cohort_id: CohortId; readonly summary: PrSummaryBody }): Promise<Result<VerifiedPrObservation, FinalIntegrationVerificationError>> => {
  const rows = await dependencies.sql.query<FinalIntegrationRow>(
    `SELECT cohort.frozen_inputs,run.context FROM oakridge.cohort cohort
     JOIN oakridge.stage_instance stage ON stage.id=cohort.stage_instance_id
     JOIN oakridge.workflow_run run ON run.id=cohort.run_id WHERE cohort.id=$1 AND stage.stage_key='final_integration'`, [input.cohort_id]);
  const repository = rows[0]?.frozen_inputs.repository;
  const forge = rows[0]?.context.repositories.find((candidate) => candidate.key === repository?.repository_key)?.forge_repository;
  const failure = (detail: string) => err({ code: "pr_verification_failed" as const, detail });
  if (!repository || !forge) return failure("final integration repository authority is missing");
  if (input.summary.repository_key !== repository.repository_key || input.summary.branch !== repository.base_branch
    || input.summary.base_branch !== repository.integration_branch) return failure("final PR summary differs from the frozen repository contract");
  const verified = await verifyPreparedPullRequest(dependencies, { repository: {
    repository_path: repository.repository_path, canonical_ref: repository.base_branch, expected_pr_base: repository.integration_branch,
  }, forge_repository: forge, candidate_url: input.summary.pr_url });
  if (!verified.ok) return failure(verified.error.detail);
  const observed = verified.value.observation;
  return ok({ repository_key: repository.repository_key as RepositoryKey, pr_url: observed.url,
    head_branch: observed.head_branch, base_branch: observed.base_branch,
    head_sha: verified.value.pushed_head_sha as CommitSha, state: observed.state === "closed_unmerged" ? "closed" : observed.state });
};
export const observeFinalIntegrationPullRequest = async (dependencies: FinalIntegrationVerificationDependencies, cohort_id: CohortId):
  Promise<Result<VerifiedPrObservation | null, FinalIntegrationVerificationError>> => {
  const rows = await dependencies.sql.query<{ readonly body: PrSummaryBody; readonly head_sha: string | null }>(
    `SELECT artifact.body,worker.response->>'head_sha' AS head_sha FROM oakridge.worker_output output
     JOIN oakridge.artifact artifact ON artifact.id=output.artifact_id
     JOIN oakridge.cohort_worker worker ON worker.cohort_id=output.cohort_id AND worker.worker=output.worker
     WHERE output.cohort_id=$1 AND output.worker='final_integration' AND output.output_name='pr_summary'`, [cohort_id]);
  const published = rows[0];
  if (!published) return ok(null);
  const observed = await verifyFinalIntegrationPullRequest(dependencies, { cohort_id, summary: published.body });
  if (!observed.ok) return observed;
  return published.head_sha && published.head_sha === observed.value.head_sha ? observed
    : err({ code: "pr_verification_failed", detail: "Final pull request head differs from the published review evidence" });
};

/** Prepare a detached worktree from the pushed run branch, without modifying the project checkout. */
export const prepareFinalIntegrationWorktree = async (dependencies: Pick<FinalIntegrationVerificationDependencies, "sql" | "git">,
  cohort_id: CohortId): Promise<Result<void, CohortPreparationError>> => {
  const failure = (kind: CohortPreparationError["kind"], detail: string): Result<never, CohortPreparationError> =>
    err({ operation: "prepare_cohort_repository", cohort_id, kind, detail });
  const rows = await dependencies.sql.query<{ readonly frozen_inputs: FinalIntegrationInputs; readonly stage_instance_id: string;
    readonly cohort_key: string; readonly state: string }>(
    "SELECT frozen_inputs,stage_instance_id::text,cohort_key,state FROM oakridge.cohort WHERE id=$1", [cohort_id]);
  const row = rows[0];
  if (!row) return failure("invalid_repository", "final integration cohort is missing");
  if (["complete", "failed", "cancelled"].includes(row.state)) return ok(undefined);
  const repository = row.frozen_inputs.repository;
  const worktree = join(repository.repository_path, ".worktrees", "oakridge", row.stage_instance_id, row.cohort_key);
  return runExclusive(repository.repository_path, async () => {
    if (existsSync(worktree)) {
      const [actual, expected, head] = await Promise.all([
        dependencies.git.run(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
        dependencies.git.run(repository.repository_path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
        dependencies.git.run(worktree, ["rev-parse", "HEAD"]),
      ]);
      return actual.exit_code === 0 && expected.exit_code === 0 && head.exit_code === 0
        && actual.stdout.trim() === expected.stdout.trim()
        ? ok(undefined) : failure("invalid_repository", "final integration worktree does not belong to the frozen repository");
    }
    const fetched = await dependencies.git.run(repository.repository_path, ["fetch", "origin", repository.base_branch]);
    if (fetched.exit_code !== 0) return failure("unavailable", fetched.stderr.trim() || "could not fetch the run branch");
    const head = await dependencies.git.run(repository.repository_path, ["rev-parse", "FETCH_HEAD"]);
    if (head.exit_code !== 0) return failure("invalid_repository", "could not resolve the pushed run branch");
    const created = await dependencies.git.run(repository.repository_path, ["worktree", "add", "--detach", worktree, head.stdout.trim()]);
    return created.exit_code === 0 ? ok(undefined) : failure("invalid_repository", created.stderr.trim() || "could not prepare final integration worktree");
  });
};

/** Discovery happens before retrying a lost final-PR publication. No external PR is created here. */
export const discoverFinalIntegrationPullRequest = async (dependencies: FinalIntegrationVerificationDependencies, cohort_id: CohortId):
  Promise<Result<VerifiedPrObservation | null, FinalIntegrationVerificationError>> => {
  const rows = await dependencies.sql.query<FinalIntegrationRow>(
    `SELECT cohort.frozen_inputs,run.context FROM oakridge.cohort cohort
     JOIN oakridge.workflow_run run ON run.id=cohort.run_id WHERE cohort.id=$1`, [cohort_id]);
  const repository = rows[0]?.frozen_inputs.repository;
  const forge = rows[0]?.context.repositories.find((candidate) => candidate.key === repository?.repository_key)?.forge_repository;
  const failure = (detail: string) => err({ code: "pr_verification_failed" as const, detail });
  if (!repository || !forge) return failure("final integration repository authority is missing");
  if (!dependencies.reader.find_for_branches) return failure("final PR discovery is unavailable; retry cannot safely create a PR");
  const candidates = await dependencies.reader.find_for_branches({ owner: forge.owner, name: forge.name,
    head_branch: repository.base_branch, base_branch: repository.integration_branch });
  if (!candidates.ok) return failure(candidates.error.detail);
  const matching = candidates.value;
  if (matching.length > 1) return failure("multiple final pull requests match the frozen branches");
  const candidate = matching[0];
  return candidate ? verifyFinalIntegrationPullRequest(dependencies, { cohort_id, summary: { repository_key: repository.repository_key,
    branch: repository.base_branch, base_branch: repository.integration_branch, pr_url: candidate.url,
    summary: "Recovered final pull request", review_status: null } }) : ok(null);
};
