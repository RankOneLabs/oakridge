import { COHORT_REPOSITORY_SOURCE } from "../storage/postgres-dev-flow";
import { err, ok, type AttemptId, type JsonValue, type Result, type UnitId, type WorkflowRunId } from "../domain/primitives";
import { parseGithubPullRequestIdentity, repositoriesMatch } from "../domain/pull-request";
import type { GitCommandRunner } from "../domain/repository-provisioning";
import type { ImplementationPublicationEvidence } from "../domain/cohort-pull-request";
import type { SqlExecutor } from "../storage/sql-executor";
import type { DevFlowPullRequestRepository, ForgeRepositoryRepository } from "../storage/repositories";
import type { PullRequestReader } from "./github-pull-requests";
import { verifyFinalIntegrationPullRequest } from "./final-integration";
import type { PrSummaryBody } from "../domain/dev-flow-artifacts";

const isJsonObject = (value: JsonValue): value is { readonly [key: string]: JsonValue } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export interface ImplementationPublicationDependencies {
  readonly sql: SqlExecutor;
  readonly git: GitCommandRunner;
  readonly pull_requests: DevFlowPullRequestRepository;
  readonly forge_repositories: ForgeRepositoryRepository;
  readonly reader: PullRequestReader;
}

interface ImplementationPublicationCommand {
  readonly attempt_id: AttemptId;
  readonly output_name: string;
  readonly body: JsonValue;
}
interface ImplementationPublicationRow {
  readonly run_id: WorkflowRunId;
  readonly repository_key: string;
  readonly repository_path: string;
  readonly canonical_ref: string;
  readonly expected_pr_base: string;
  readonly stage_instance_id: import("../domain/primitives").StageInstanceId;
  readonly cohort_key: string;
  readonly action_point: string;
}

/** Read-only verification. PR bindings are committed with the authorized artifact, never here. */
export const createImplementationPublicationEnricher = (dependencies: ImplementationPublicationDependencies) => {
  const { sql, git, pull_requests: cohortPullRequests, forge_repositories: forgeRepositories, reader } = dependencies;
  return async (input: ImplementationPublicationCommand): Promise<Result<JsonValue | null,
    { readonly code: string; readonly detail: string }>> => {
    if (input.output_name !== "pr_summary") return ok(null);
    const owners = await sql.query<{ readonly cohort_id: import("../domain/primitives").CohortId; readonly stage_key: string }>(
      `SELECT attempt.cohort_id::text,stage.stage_key FROM oakridge.attempt attempt
       JOIN oakridge.stage_instance stage ON stage.id=attempt.stage_instance_id WHERE attempt.id=$1`, [input.attempt_id]);
    if (owners[0]?.stage_key === "final_integration") {
      if (!isJsonObject(input.body) || typeof input.body.pr_url !== "string" || typeof input.body.repository_key !== "string"
        || typeof input.body.branch !== "string" || typeof input.body.base_branch !== "string")
        return err({ code: "pr_verification_failed", detail: "final PR summary is missing its identity or branches" });
      const verified = await verifyFinalIntegrationPullRequest(dependencies, {
        cohort_id: owners[0].cohort_id, summary: input.body as unknown as PrSummaryBody });
      return verified.ok ? ok({ origin_head_sha: verified.value.head_sha, pr: verified.value } as unknown as JsonValue) : verified;
    }
    const rows = await sql.query<ImplementationPublicationRow>(
      `SELECT attempt.run_id,build.repository_key,build.repository_path,build.canonical_ref,build.expected_pr_base,
         build.stage_instance_id,build.cohort_key,worker.work->>'action_point' AS action_point
       FROM oakridge.attempt attempt JOIN ${COHORT_REPOSITORY_SOURCE} build ON build.cohort_id=attempt.cohort_id
       JOIN oakridge.execution_intent intent ON intent.attempt_id=attempt.id
       JOIN oakridge.cohort_worker worker ON worker.cohort_id=intent.cohort_id AND worker.worker=intent.worker
       WHERE attempt.id=$1`, [input.attempt_id]);
    const roles = rows[0];
    const expected_repository = roles ? await forgeRepositories.find_forge_repository(roles.run_id, roles.repository_key) : null;
    const url = isJsonObject(input.body) && typeof input.body.pr_url === "string" ? input.body.pr_url : null;
    const identity = url ? parseGithubPullRequestIdentity(url) : null;
    const invalid = (detail: string) => err({ code: "pr_verification_failed", detail });
    if (!url || !identity || !roles || !expected_repository) return invalid("PR identity or repository authority is missing");
    if (!isJsonObject(input.body) || input.body.repository_key !== roles.repository_key
      || input.body.branch !== roles.canonical_ref || input.body.base_branch !== roles.expected_pr_base)
      return invalid("PR summary disagrees with the cohort repository or branch contract");
    if (!repositoriesMatch(identity.owner, identity.name, expected_repository.owner, expected_repository.name))
      return invalid("PR URL belongs to a different repository");
    const reading = await reader.read(identity.owner, identity.name, identity.number);
    if (!reading.ok) return err({ code: "enrichment_unavailable", detail: reading.error.detail });
    if (reading.value === null) return invalid("PR was not found at the forge");
    const observed = reading.value;
    if (!repositoriesMatch(observed.owner, observed.name, expected_repository.owner, expected_repository.name)
      || observed.number !== identity.number || observed.head_branch !== roles.canonical_ref
      || observed.base_branch !== roles.expected_pr_base || !observed.head_sha)
      return invalid("forge PR observation disagrees with the cohort repository, branches, or head");
    const ref = `refs/heads/${roles.canonical_ref}`;
    let remote: Awaited<ReturnType<GitCommandRunner["run"]>>;
    try { remote = await git.run(roles.repository_path, ["ls-remote", "origin", ref]); }
    catch (error) { return err({ code: "enrichment_unavailable", detail: String(error) }); }
    if (remote.exit_code !== 0) return err({ code: "enrichment_unavailable", detail: remote.stderr.trim() || "origin could not be read" });
    const origin_head_sha = remote.stdout.trim().split(/\s+/)[0] || null;
    if (origin_head_sha !== observed.head_sha) return invalid("forge PR head differs from the pushed cohort head");
    const cohort = await cohortPullRequests.find_cohort_for_unit(roles.stage_instance_id, roles.cohort_key as UnitId);
    if (!cohort) return invalid("prepared cohort repository is missing");
    const current = await cohortPullRequests.find_current_for_unit(roles.stage_instance_id, roles.cohort_key as UnitId);
    if (roles.action_point === "replace_pr") {
      if (!current) return invalid("replacement has no current verified PR");
      if (observed.state !== "open") return invalid("replacement PR must be open");
      if (current.pull_request.forge_pull_request_id === observed.number)
        return invalid("replacement must identify a different PR");
    }
    const evidence: ImplementationPublicationEvidence = { pr: observed, origin_head_sha,
      replace_verification_id: roles.action_point === "replace_pr"
        ? current?.cohort.current_verified_pull_request_id ?? null : null };
    return ok(evidence as unknown as JsonValue);
  };
};
