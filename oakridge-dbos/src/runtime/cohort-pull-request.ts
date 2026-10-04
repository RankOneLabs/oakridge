/**
 * Closing a cohort's `github_review` wait on evidence that its pull request
 * merged.
 *
 * A build unit's `build_result` is released through a handoff whose external
 * wait is `github_review`. The poller and operator recheck both arrive here,
 * but neither supplies trusted state: each triggers a fresh forge read and
 * origin ref check before reconciliation.
 *
 * The wait is named `github_review` and the evidence is a pull request. Its
 * identity comes from the cohort's current verified PR link; agent-authored
 * artifact bodies never become verification evidence.
 */
import type { CohortRepositoryRecord } from "../domain/cohort-pull-request";
import { err, ok, type CohortId, type Result, type StageInstanceId, type UnitId } from "../domain/primitives";
import type { PullRequestObservation } from "../domain/pull-request";
import { parseGithubPullRequestIdentity, repositoriesMatch, type PullRequestVerificationId } from "../domain/pull-request";
import type { GitCommandRunner } from "../domain/repository-provisioning";
import { renderCohortBranchContract, selectCohortBranchRoles, type RepositoryRefs } from "../domain/repository-refs";
import type { DevFlowPullRequestRepository } from "../storage/repositories";

export interface PrepareCohortRepositoryRecordInput {
  readonly cohort_id: CohortId;
  readonly stage_instance_id: StageInstanceId;
  readonly cohort_key: string;
  readonly repository: RepositoryRefs;
  readonly prepared_at: string;
}

export interface PreparedCohortRepositoryRecord {
  readonly cohort: CohortRepositoryRecord;
  readonly branch_contract: string;
  /** The observed run-base head used to create this cohort's ref. */
  readonly worktree_base_sha: string;
}

export interface PrepareCohortRepositoryRecordError {
  readonly operation: "prepare_cohort_repository";
  readonly kind: "git_read_failed" | "ref_lease_mismatch" | "git_command_failed" | "cohort_storage_failed";
  readonly detail: string;
}

const prepareFailure = (kind: PrepareCohortRepositoryRecordError["kind"], detail: string): Result<never, PrepareCohortRepositoryRecordError> =>
  err({ operation: "prepare_cohort_repository", kind, detail });

/** Creates the canonical ref and stores the exact same branch roles rendered into the agent contract. */
export const prepareCohortRepositoryRecord = async (
  dependencies: { readonly pull_requests: DevFlowPullRequestRepository; readonly git: GitCommandRunner },
  input: PrepareCohortRepositoryRecordInput,
): Promise<Result<PreparedCohortRepositoryRecord, PrepareCohortRepositoryRecordError>> => {
  const roles = selectCohortBranchRoles(input.stage_instance_id, input.cohort_key, input.repository);
  let existing = await dependencies.pull_requests.find_cohort_for_unit(input.stage_instance_id, input.cohort_key as UnitId);
  if (existing && (existing.cohort_id !== input.cohort_id || existing.repository_key !== input.repository.repository_key
      || existing.repository_path !== input.repository.repository_path || existing.canonical_ref !== roles.canonical_ref
      || existing.expected_pr_base !== roles.expected_pr_base)) {
    return prepareFailure("ref_lease_mismatch", "stored build cohort does not match the requested repository and branch roles");
  }
  const ref = `refs/heads/${roles.canonical_ref}`;
  const remote = await dependencies.git.run(input.repository.repository_path, ["ls-remote", "origin", ref]);
  if (remote.exit_code !== 0) return prepareFailure("git_read_failed", remote.stderr.trim() || "could not read origin cohort ref");
  const remoteHead = remote.stdout.trim().split(/\s+/)[0] ?? "";
  if (remoteHead !== "" && !existing)
    return prepareFailure("ref_lease_mismatch", "origin cohort ref exists without a stored cohort lease");
  const expectedHead = existing?.recorded_head_sha ?? null;
  if (remoteHead !== "" && remoteHead !== expectedHead) {
    return prepareFailure("ref_lease_mismatch", `origin cohort ref already points at '${remoteHead}', expected '${expectedHead}'`);
  }
  if (!existing) {
    const base = await dependencies.git.run(input.repository.repository_path,
      ["ls-remote", "origin", `refs/heads/${input.repository.base_branch}`]);
    if (base.exit_code !== 0) return prepareFailure("git_read_failed", base.stderr.trim() || "could not read origin base ref");
    const currentBase = base.stdout.trim().split(/\s+/)[0];
    if (!currentBase) return prepareFailure("git_read_failed", "origin base ref is missing");
    // The committed row owns this exact ref and SHA before any remote mutation.
    // A retry uses that state even if the run base has advanced meanwhile.
    const stored = await dependencies.pull_requests.create_cohort({
      cohort_id: input.cohort_id, stage_instance_id: input.stage_instance_id, cohort_key: input.cohort_key,
      repository_key: input.repository.repository_key, repository_path: input.repository.repository_path,
      canonical_ref: roles.canonical_ref, expected_pr_base: roles.expected_pr_base,
      recorded_head_sha: currentBase, current_verified_pull_request_id: null,
      created_at: input.prepared_at, updated_at: input.prepared_at,
    });
    if (!stored.ok) return prepareFailure("cohort_storage_failed", stored.error.detail);
    existing = stored.value;
  }
  const branchBase = existing.recorded_head_sha;
  if (remoteHead === "") {
    // GitHub-created merge commits may not exist in this checkout yet. Fetch
    // the exact observed object without updating shared remote-tracking refs.
    const fetched = await dependencies.git.run(input.repository.repository_path,
      ["fetch", "--no-write-fetch-head", "--refmap=", "origin", branchBase]);
    if (fetched.exit_code !== 0) return prepareFailure("git_read_failed", fetched.stderr.trim() || "could not fetch origin base commit");
    const pushed = await dependencies.git.run(input.repository.repository_path,
      ["push", `--force-with-lease=${ref}:`, "origin", `${branchBase}:${ref}`]);
    if (pushed.exit_code !== 0) {
      // A concurrent retry may have created the same owned ref already.
      const reconciled = await dependencies.git.run(input.repository.repository_path, ["ls-remote", "origin", ref]);
      if (reconciled.exit_code !== 0 || reconciled.stdout.trim().split(/\s+/)[0] !== branchBase)
        return prepareFailure("git_command_failed", pushed.stderr.trim() || "could not create origin cohort ref");
    }
  }
  return ok({ cohort: existing, branch_contract: renderCohortBranchContract(existing), worktree_base_sha: branchBase });
};

export interface PullRequestForgeReader {
  read(owner: string, name: string, number: number): Promise<PullRequestObservation | null
    | Result<PullRequestObservation | null, import("./github-pull-requests").PullRequestReadError>>;
}

export interface VerifyCohortPullRequestInput {
  readonly cohort: CohortRepositoryRecord;
  readonly forge_repository: { readonly owner: string; readonly name: string };
  readonly candidate_url: string;
}

export interface VerifiedCohortPullRequest {
  readonly observation: PullRequestObservation;
  readonly pushed_head_sha: string;
}

export interface BoundVerifiedCohortPullRequest extends VerifiedCohortPullRequest {
  readonly pull_request_id: import("../domain/pull-request").PullRequestId;
  readonly observation_id: import("../domain/pull-request").PullRequestObservationId;
  readonly verification_id: PullRequestVerificationId;
  readonly binding: "created" | "current" | "replaced" | "head_advanced";
  readonly pull_request_url: string;
  readonly head_sha: string;
}

export interface PullRequestBindingError {
  readonly operation: "verify_cohort_pull_request";
  readonly kind: "replacement_required" | "replacement_conflict" | "cohort_repository_not_found";
  readonly detail: string;
  readonly current_verification_id: PullRequestVerificationId | null;
}

export interface CohortPullRequestVerificationError {
  readonly operation: "verify_cohort_pull_request";
  readonly kind: "invalid_pull_request_url" | "repository_mismatch" | "unreadable_pull_request" | "head_ref_mismatch" | "base_ref_mismatch" | "missing_head_commit" | "git_read_failed" | "head_commit_mismatch";
  readonly detail: string;
}

const verificationFailure = (kind: CohortPullRequestVerificationError["kind"], detail: string): Result<never, CohortPullRequestVerificationError> =>
  err({ operation: "verify_cohort_pull_request", kind, detail });

export interface PreparedPullRequestBranches {
  readonly repository_path: string;
  readonly canonical_ref: string;
  readonly expected_pr_base: string;
}
export interface VerifyPreparedPullRequestInput {
  readonly repository: PreparedPullRequestBranches;
  readonly forge_repository: VerifyCohortPullRequestInput["forge_repository"];
  readonly candidate_url: string;
}
/** Reads both authorities. No field from an agent artifact can satisfy verification. */
export const verifyPreparedPullRequest = async (
  dependencies: { readonly reader: PullRequestForgeReader; readonly git: GitCommandRunner },
  input: VerifyPreparedPullRequestInput,
): Promise<Result<VerifiedCohortPullRequest, CohortPullRequestVerificationError>> => {
  const identity = parseGithubPullRequestIdentity(input.candidate_url);
  if (!identity) return verificationFailure("invalid_pull_request_url", "candidate URL is not a canonical GitHub pull request URL");
  if (!repositoriesMatch(identity.owner, identity.name, input.forge_repository.owner, input.forge_repository.name)) {
    return verificationFailure("repository_mismatch", "candidate URL does not belong to the cohort repository");
  }
  const reading = await dependencies.reader.read(identity.owner, identity.name, identity.number).catch(() => null);
  const observation = reading && "ok" in reading ? reading.ok ? reading.value : null : reading;
  if (!observation) return verificationFailure("unreadable_pull_request", "forge did not return the candidate pull request");
  if (!repositoriesMatch(observation.owner, observation.name, input.forge_repository.owner, input.forge_repository.name)
      || observation.number !== identity.number || !repositoriesMatch(observation.owner, observation.name, identity.owner, identity.name)) {
    return verificationFailure("repository_mismatch", "forge observation does not match the candidate repository and pull request id");
  }
  if (observation.head_branch !== input.repository.canonical_ref) {
    return verificationFailure("head_ref_mismatch", `forge head '${observation.head_branch}' does not match '${input.repository.canonical_ref}'`);
  }
  if (observation.base_branch !== input.repository.expected_pr_base) {
    return verificationFailure("base_ref_mismatch", `forge base '${observation.base_branch}' does not match '${input.repository.expected_pr_base}'`);
  }
  if (!observation.head_sha) return verificationFailure("missing_head_commit", "forge observation has no head commit");
  const remote = await dependencies.git.run(input.repository.repository_path, ["ls-remote", "origin", `refs/heads/${input.repository.canonical_ref}`]);
  if (remote.exit_code !== 0) return verificationFailure("git_read_failed", remote.stderr.trim() || "could not read the cohort ref from origin");
  const pushedHead = remote.stdout.trim().split(/\s+/)[0] ?? "";
  // A merged PR retains its head SHA at the forge after GitHub deletes the
  // branch. Missing refs are valid only for a confirmed merge; an existing ref
  // must still match, and callers compare this SHA with the reviewed head.
  if (pushedHead === "" && observation.state === "merged" && observation.merged_at !== null)
    return ok({ observation, pushed_head_sha: observation.head_sha });
  if (pushedHead === "" || pushedHead !== observation.head_sha) {
    return verificationFailure("head_commit_mismatch", `forge head '${observation.head_sha}' is not pushed origin head '${pushedHead || "missing"}'`);
  }
  return ok({ observation, pushed_head_sha: pushedHead });
};

export const verifyCohortPullRequest = (
  dependencies: { readonly reader: PullRequestForgeReader; readonly git: GitCommandRunner },
  input: VerifyCohortPullRequestInput,
): Promise<Result<VerifiedCohortPullRequest, CohortPullRequestVerificationError>> =>
  verifyPreparedPullRequest(dependencies, { repository: input.cohort, forge_repository: input.forge_repository, candidate_url: input.candidate_url });

/** Verify against forge and origin, then retain the verified binding. */
export const verifyAndBindCohortPullRequest = async (
  dependencies: {
    readonly pull_requests: DevFlowPullRequestRepository;
    readonly reader: PullRequestForgeReader;
    readonly git: GitCommandRunner;
    readonly now: () => string;
  },
  input: VerifyCohortPullRequestInput & { readonly replace_verification_id: PullRequestVerificationId | null },
): Promise<Result<BoundVerifiedCohortPullRequest, CohortPullRequestVerificationError | PullRequestBindingError>> => {
  const verified = await verifyCohortPullRequest(dependencies, input);
  if (!verified.ok) return verified;
  const recordedAt = dependencies.now();
  const current = await dependencies.pull_requests.find_current_for_unit(input.cohort.stage_instance_id, input.cohort.cohort_key as UnitId);
  const stored = await dependencies.pull_requests.observe({ observation: verified.value.observation, recorded_at: recordedAt });
  const isCurrent = current?.pull_request.id === stored.pull_request_id
    && current.observation.head_sha === verified.value.pushed_head_sha;
  let verificationId = current?.cohort.current_verified_pull_request_id ?? null;
  let binding: BoundVerifiedCohortPullRequest["binding"] = isCurrent ? "current" : "created";
  if (!isCurrent) {
    const bound = await dependencies.pull_requests.bind_verified({ cohort_id: input.cohort.cohort_id, ...stored,
      verified_head_sha: verified.value.pushed_head_sha, verified_at: recordedAt,
      replace_verification_id: input.replace_verification_id });
    if (!bound.ok) {
      return err({ operation: "verify_cohort_pull_request", ...bound.error,
        current_verification_id: current?.cohort.current_verified_pull_request_id ?? null });
    }
    verificationId = bound.value.id;
    binding = bound.value.binding;
  }
  if (!verificationId) return verificationFailure("unreadable_pull_request", "verified pull request binding was not retained");
  return ok({ ...verified.value, ...stored, verification_id: verificationId, binding,
    pull_request_url: verified.value.observation.url, head_sha: verified.value.pushed_head_sha });
};
