/**
 * Completing a cohort on evidence that its pull request merged.
 *
 * The poller and the operator's confirm-merged both arrive here, and neither
 * supplies trusted state: each triggers a fresh forge read and origin ref check
 * before reconciliation. Identity comes from the cohort's current verified PR
 * link; agent-authored artifact bodies never become verification evidence.
 *
 * A merge is recorded as a `pull_request_merge_closure` and told to the cohort's
 * machine as `pull_request_merged`. It used to close a `github_review` handoff
 * wait instead, which `dev_flow_v15` does not declare — no stage in it declares a
 * handoff at all — so every read here refused before reaching the checks. The
 * handoff close is still performed for a definition that declares one.
 */
import {
  reconcileCohortPullRequest,
  type CohortPullRequestReconciliation, type DevFlowBuildCohort, type ExpectedCohortPullRequest,
  type RunOwnedCohortHandoff,
} from "../domain/cohort-pull-request";
import type { ReportedBuildCohortEvent } from "../adapters/dev-flow-build";
import { err, ok, type CohortId, type Result, type StageInstanceId, type UnitId, type WorkflowRunId } from "../domain/primitives";
import type { PullRequestObservation } from "../domain/pull-request";
import { parseGithubPullRequestIdentity, repositoriesMatch, type PullRequestVerificationId } from "../domain/pull-request";
import type { GitCommandRunner } from "../domain/repository-provisioning";
import { renderCohortBranchContract, selectCohortBranchRoles, type RepositoryRefs } from "../domain/repository-refs";
import type { DevFlowPullRequestRepository, FinalPullRequestTargetRepository, RunRecordRepository } from "../storage/repositories";

const GITHUB_REVIEW_WAIT = "github_review";

export interface CohortPullRequestDependencies {
  readonly pull_requests: DevFlowPullRequestRepository;
  /**
   * The forge identity a candidate pull request URL is checked against, read
   * from the run's own context. It used to come from `epic_workflow_profile`,
   * which v15 does not have; what matters for the check is unchanged — the
   * identity is launch configuration, never a field an agent's artifact
   * supplied.
   */
  readonly forge_targets: FinalPullRequestTargetRepository;
  readonly reader: PullRequestForgeReader;
  readonly git: GitCommandRunner;
  readonly records: Pick<RunRecordRepository, "find_cohort_handoff" | "complete_handoff_artifact" | "find_cohort_state">;
  readonly now: () => string;
  readonly record_build_event: (cohort_id: CohortId, event: ReportedBuildCohortEvent) => Promise<void>;
  /** Wakes the run's root sooner than its bounded recheck once a merge completes a cohort — a hint, never a decision. */
  readonly send_run_wake?: (run_id: WorkflowRunId, idempotency_key: string) => Promise<void>;
}

export interface PrepareDevFlowBuildCohortInput {
  readonly cohort_id: CohortId;
  readonly stage_instance_id: StageInstanceId;
  readonly cohort_key: string;
  readonly repository: RepositoryRefs;
  readonly prepared_at: string;
}

export interface PreparedDevFlowBuildCohort {
  readonly cohort: DevFlowBuildCohort;
  readonly branch_contract: string;
}

export interface PrepareDevFlowBuildCohortError {
  readonly operation: "prepare_dev_flow_build_cohort";
  readonly kind: "git_read_failed" | "ref_lease_mismatch" | "git_command_failed";
  readonly detail: string;
}

const prepareFailure = (kind: PrepareDevFlowBuildCohortError["kind"], detail: string): Result<never, PrepareDevFlowBuildCohortError> =>
  err({ operation: "prepare_dev_flow_build_cohort", kind, detail });

/** Creates the canonical ref and stores the exact same branch roles rendered into the agent contract. */
export const prepareDevFlowBuildCohort = async (
  dependencies: { readonly pull_requests: DevFlowPullRequestRepository; readonly git: GitCommandRunner },
  input: PrepareDevFlowBuildCohortInput,
): Promise<Result<PreparedDevFlowBuildCohort, PrepareDevFlowBuildCohortError>> => {
  const roles = selectCohortBranchRoles(input.stage_instance_id, input.cohort_key, input.repository);
  const existing = await dependencies.pull_requests.find_cohort_for_unit(input.stage_instance_id, input.cohort_key as UnitId);
  if (existing && (existing.cohort_id !== input.cohort_id || existing.repository_key !== input.repository.repository_key
      || existing.repository_path !== input.repository.repository_path || existing.canonical_ref !== roles.canonical_ref
      || existing.expected_pr_base !== roles.expected_pr_base)) {
    return prepareFailure("ref_lease_mismatch", "stored build cohort does not match the requested repository and branch roles");
  }
  const ref = `refs/heads/${roles.canonical_ref}`;
  const remote = await dependencies.git.run(input.repository.repository_path, ["ls-remote", "origin", ref]);
  if (remote.exit_code !== 0) return prepareFailure("git_read_failed", remote.stderr.trim() || "could not read origin cohort ref");
  const remoteHead = remote.stdout.trim().split(/\s+/)[0] ?? "";
  const expectedHead = existing?.recorded_head_sha ?? input.repository.base_head_sha;
  if (remoteHead !== "" && remoteHead !== expectedHead) {
    return prepareFailure("ref_lease_mismatch", `origin cohort ref already points at '${remoteHead}', expected '${expectedHead}'`);
  }
  if (remoteHead === "" && existing) {
    return prepareFailure("ref_lease_mismatch", `stored cohort ref '${roles.canonical_ref}' is missing from origin`);
  }
  if (remoteHead === "" && !existing) {
    const pushed = await dependencies.git.run(input.repository.repository_path,
      ["push", `--force-with-lease=${ref}:`, "origin", `${input.repository.base_head_sha}:${ref}`]);
    if (pushed.exit_code !== 0) return prepareFailure("git_command_failed", pushed.stderr.trim() || "could not create origin cohort ref");
  }
  if (existing) return ok({ cohort: existing, branch_contract: renderCohortBranchContract(existing) });
  const cohort = await dependencies.pull_requests.create_cohort({
    cohort_id: input.cohort_id, stage_instance_id: input.stage_instance_id, cohort_key: input.cohort_key,
    repository_key: input.repository.repository_key, repository_path: input.repository.repository_path,
    canonical_ref: roles.canonical_ref, expected_pr_base: roles.expected_pr_base,
    recorded_head_sha: input.repository.base_head_sha, current_verified_pull_request_id: null,
    created_at: input.prepared_at, updated_at: input.prepared_at,
  });
  return ok({ cohort, branch_contract: renderCohortBranchContract(cohort) });
};

export interface PullRequestForgeReader {
  read(owner: string, name: string, number: number): Promise<PullRequestObservation | null>;
}

export interface VerifyCohortPullRequestInput {
  readonly cohort: DevFlowBuildCohort;
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
  /**
   * `rebound` is the same pull request at a new head — a builder pushed again.
   * `replaced` is a *different* pull request taking over from one already bound,
   * which is the only one of the two the machine treats as a replacement.
   */
  readonly binding: "created" | "current" | "rebound" | "replaced";
}

export interface PullRequestBindingError {
  readonly operation: "verify_cohort_pull_request";
  readonly kind: "replacement_required" | "replacement_conflict";
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

/** Reads both authorities. No field from an agent artifact can satisfy verification. */
export const verifyCohortPullRequest = async (
  dependencies: { readonly reader: PullRequestForgeReader; readonly git: GitCommandRunner },
  input: VerifyCohortPullRequestInput,
): Promise<Result<VerifiedCohortPullRequest, CohortPullRequestVerificationError>> => {
  const identity = parseGithubPullRequestIdentity(input.candidate_url);
  if (!identity) return verificationFailure("invalid_pull_request_url", "candidate URL is not a canonical GitHub pull request URL");
  if (!repositoriesMatch(identity.owner, identity.name, input.forge_repository.owner, input.forge_repository.name)) {
    return verificationFailure("repository_mismatch", "candidate URL does not belong to the cohort repository");
  }
  const observation = await dependencies.reader.read(identity.owner, identity.name, identity.number).catch(() => null);
  if (!observation) return verificationFailure("unreadable_pull_request", "forge did not return the candidate pull request");
  if (!repositoriesMatch(observation.owner, observation.name, input.forge_repository.owner, input.forge_repository.name)
      || observation.number !== identity.number || !repositoriesMatch(observation.owner, observation.name, identity.owner, identity.name)) {
    return verificationFailure("repository_mismatch", "forge observation does not match the candidate repository and pull request id");
  }
  if (observation.head_branch !== input.cohort.canonical_ref) {
    return verificationFailure("head_ref_mismatch", `forge head '${observation.head_branch}' does not match '${input.cohort.canonical_ref}'`);
  }
  if (observation.base_branch !== input.cohort.expected_pr_base) {
    return verificationFailure("base_ref_mismatch", `forge base '${observation.base_branch}' does not match '${input.cohort.expected_pr_base}'`);
  }
  if (!observation.head_sha) return verificationFailure("missing_head_commit", "forge observation has no head commit");
  const remote = await dependencies.git.run(input.cohort.repository_path, ["ls-remote", "origin", `refs/heads/${input.cohort.canonical_ref}`]);
  if (remote.exit_code !== 0) return verificationFailure("git_read_failed", remote.stderr.trim() || "could not read the cohort ref from origin");
  const pushedHead = remote.stdout.trim().split(/\s+/)[0] ?? "";
  if (pushedHead === "" || pushedHead !== observation.head_sha) {
    return verificationFailure("head_commit_mismatch", `forge head '${observation.head_sha}' is not pushed origin head '${pushedHead || "missing"}'`);
  }
  return ok({ observation, pushed_head_sha: pushedHead });
};

/** Shared cohort/final-stage boundary: verify, retain the observation, bind it, then notify the build machine. */
export const verifyAndBindCohortPullRequest = async (
  dependencies: {
    readonly pull_requests: DevFlowPullRequestRepository;
    readonly reader: PullRequestForgeReader;
    readonly git: GitCommandRunner;
    readonly now: () => string;
    readonly record_build_event: (cohort_id: CohortId, event: ReportedBuildCohortEvent) => Promise<void>;
  },
  input: VerifyCohortPullRequestInput & { readonly replace_verification_id: PullRequestVerificationId | null },
): Promise<Result<BoundVerifiedCohortPullRequest, CohortPullRequestVerificationError | PullRequestBindingError>> => {
  const verified = await verifyCohortPullRequest(dependencies, input);
  if (!verified.ok) {
    await dependencies.record_build_event(input.cohort.cohort_id,
      { kind: "pull_request_mismatch", pull_request_url: input.candidate_url });
    return verified;
  }
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
      await dependencies.record_build_event(input.cohort.cohort_id,
        { kind: "replacement_pull_request_required", pull_request_url: input.candidate_url });
      return err({ operation: "verify_cohort_pull_request", ...bound.error,
        current_verification_id: current?.cohort.current_verified_pull_request_id ?? null });
    }
    verificationId = bound.value;
    // Only a *different* pull request displaces one. Re-verifying the same one
    // after the builder pushed again is a rebind: reporting it as a replacement
    // sent the machine down `replacement_pr`, which restarts the builder and
    // discards the verification — for the ordinary case of a branch gaining a
    // commit, which is every publication after the first.
    if (current && current.pull_request.id !== stored.pull_request_id) {
      binding = "replaced";
      await dependencies.record_build_event(input.cohort.cohort_id, { kind: "replacement_pull_request_required",
        pull_request_url: current.pull_request.url });
    } else if (current) {
      binding = "rebound";
    }
  }
  if (!verificationId) return verificationFailure("unreadable_pull_request", "verified pull request binding was not retained");
  // Emitted on re-verification too: if the first delivery failed after the
  // binding committed, a retry must be able to deliver the idempotent fact.
  await dependencies.record_build_event(input.cohort.cohort_id, { kind: "pull_request_verified",
    head_sha: verified.value.pushed_head_sha, pull_request_url: verified.value.observation.url });
  return ok({ ...verified.value, ...stored, verification_id: verificationId, binding });
};

export interface AdvanceCohortRefInput { readonly cohort: DevFlowBuildCohort; readonly next_head_sha: string }
export interface CohortRefAdvanceError {
  readonly operation: "advance_cohort_ref";
  readonly kind: "ref_lease_mismatch" | "non_descendant_head" | "git_command_failed";
  readonly detail: string;
}
const refAdvanceFailure = (kind: CohortRefAdvanceError["kind"], detail: string): Result<never, CohortRefAdvanceError> =>
  err({ operation: "advance_cohort_ref", kind, detail });

/** An ancestry check protects reviewed work; the push lease protects the check itself. */
const advanceCohortRefWithIntent = async (
  git: GitCommandRunner,
  input: AdvanceCohortRefInput,
  leaseIntentHeadSha: string | null,
): Promise<Result<{ readonly head_sha: string }, CohortRefAdvanceError>> => {
  const ref = `refs/heads/${input.cohort.canonical_ref}`;
  const remote = await git.run(input.cohort.repository_path, ["ls-remote", "origin", ref]);
  if (remote.exit_code !== 0) return refAdvanceFailure("git_command_failed", remote.stderr.trim() || "could not read origin ref");
  const remoteHead = remote.stdout.trim().split(/\s+/)[0] ?? "";
  const isRecoveringRecordedIntent = remoteHead === input.next_head_sha && leaseIntentHeadSha === input.next_head_sha;
  if (remoteHead !== input.cohort.recorded_head_sha && !isRecoveringRecordedIntent) {
    return refAdvanceFailure("ref_lease_mismatch", `origin moved from recorded head '${input.cohort.recorded_head_sha}' to '${remoteHead || "missing"}'`);
  }
  const ancestry = await git.run(input.cohort.repository_path, ["merge-base", "--is-ancestor", input.cohort.recorded_head_sha, input.next_head_sha]);
  if (ancestry.exit_code === 1) return refAdvanceFailure("non_descendant_head", "next cohort head does not descend from the recorded head");
  if (ancestry.exit_code !== 0) return refAdvanceFailure("git_command_failed", ancestry.stderr.trim() || "could not check cohort ref ancestry");
  if (remoteHead !== input.next_head_sha) {
    const pushed = await git.run(input.cohort.repository_path, ["push", `--force-with-lease=${ref}:${input.cohort.recorded_head_sha}`, "origin", `${input.next_head_sha}:${ref}`]);
    if (pushed.exit_code !== 0) return refAdvanceFailure("ref_lease_mismatch", pushed.stderr.trim() || "origin refused the cohort ref lease");
  }
  return ok({ head_sha: input.next_head_sha });
};

/** Strict low-level check; crash recovery is available only through the storage-backed wrapper below. */
export const advanceCohortRef = (
  git: GitCommandRunner,
  input: AdvanceCohortRefInput,
): Promise<Result<{ readonly head_sha: string }, CohortRefAdvanceError>> => advanceCohortRefWithIntent(git, input, null);

/** Advances origin first, then records the same lease in cohort storage for the next writer. */
export const advanceStoredCohortRef = async (
  dependencies: { readonly pull_requests: DevFlowPullRequestRepository; readonly git: GitCommandRunner; readonly now: () => string },
  input: AdvanceCohortRefInput,
): Promise<Result<DevFlowBuildCohort, CohortRefAdvanceError>> => {
  const intent = await dependencies.pull_requests.begin_cohort_advance({ cohort_id: input.cohort.cohort_id,
    expected_head_sha: input.cohort.recorded_head_sha, next_head_sha: input.next_head_sha, prepared_at: dependencies.now() });
  if (!intent.ok) return refAdvanceFailure(intent.error.kind === "ref_lease_mismatch" ? "ref_lease_mismatch" : "git_command_failed", intent.error.detail);
  const advanced = await advanceCohortRefWithIntent(dependencies.git, input, input.next_head_sha);
  if (!advanced.ok) return advanced;
  const stored = await dependencies.pull_requests.advance_cohort_head({ cohort_id: input.cohort.cohort_id,
    expected_head_sha: input.cohort.recorded_head_sha, next_head_sha: advanced.value.head_sha, advanced_at: dependencies.now() });
  if (!stored.ok) return refAdvanceFailure(stored.error.kind === "ref_lease_mismatch" ? "ref_lease_mismatch" : "git_command_failed", stored.error.detail);
  return ok(stored.value);
};

/** How the evidence arrived. Both kinds are reconciled identically. */
export type CohortPullRequestEvidence =
  | { readonly kind: "observation"; readonly observation: PullRequestObservation; readonly replace_verification_id?: PullRequestVerificationId | null }
  | { readonly kind: "operator_confirmation"; readonly idempotency_key: string; readonly operator_comment: string };

export interface CohortPullRequestError {
  readonly operation: "reconcile_cohort_pull_request";
  readonly kind: "cohort_not_found" | "not_a_pull_request_cohort" | "missing_pull_request_evidence" | "mismatch";
  readonly detail: string;
  readonly reconciliation?: CohortPullRequestReconciliation;
  readonly current_verification_id?: PullRequestVerificationId | null;
}

/**
 * What became of the evidence.
 *
 * `merged_not_awaiting` is a real state, not a failure: a definition that declares
 * a handoff had no wait open to close. The closure is recorded and the cohort's
 * machine is told either way, which is what completes the cohort — an early merge
 * needs no wait, because the machine carries `is_pull_request_merged` until the
 * assessment is approved.
 */
export type CohortPullRequestResolution =
  | { readonly kind: "completed" }
  | { readonly kind: "already_completed" }
  | { readonly kind: "merged_not_awaiting"; readonly handoff_status: string | null }
  | { readonly kind: "waiting" }
  | { readonly kind: "ignored_stale" };

export interface ResolvedCohortPullRequest {
  readonly resolution: CohortPullRequestResolution;
  readonly reconciliation: CohortPullRequestReconciliation;
  readonly verification_id: PullRequestVerificationId;
}

const failure = (kind: CohortPullRequestError["kind"], detail: string, options: Pick<CohortPullRequestError, "reconciliation" | "current_verification_id"> = {}): Result<never, CohortPullRequestError> =>
  err({ operation: "reconcile_cohort_pull_request", kind, detail, ...options });

interface CohortPullRequestContext {
  readonly expected: ExpectedCohortPullRequest;
  readonly cohort: DevFlowBuildCohort;
  /** The handoff this cohort's output releases through, when its stage declares one. */
  readonly handoff: RunOwnedCohortHandoff | null;
}

/**
 * The run a stored cohort belongs to. `dev_flow_build_cohort` is keyed by
 * (stage instance, unit) and keeps no run id, and the handoff record that used to
 * supply one only exists for a stage that declares a handoff — which no v15 stage
 * does. The cohort's own machine state has it.
 */
const runIdOf = async (dependencies: CohortPullRequestDependencies, cohort_id: CohortId): Promise<WorkflowRunId | null> =>
  (await dependencies.records.find_cohort_state(cohort_id))?.run_id ?? null;

/**
 * Everything the run already knows about this cohort's pull request.
 *
 * Built from the stored cohort and the verified PR link rather than from a
 * handoff record. Requiring the handoff meant every read here refused with
 * `cohort_not_found` under `dev_flow_v15`, whose stages declare gates only — so
 * neither the merge poller nor the operator's confirm-merged button could reach
 * the checks at all.
 */
const loadCohortContext = async (
  dependencies: CohortPullRequestDependencies,
  stageInstanceId: StageInstanceId,
  unitId: UnitId,
): Promise<Result<CohortPullRequestContext, CohortPullRequestError>> => {
  const cohort = await dependencies.pull_requests.find_cohort_for_unit(stageInstanceId, unitId);
  if (!cohort) return failure("cohort_not_found", `no stored build cohort for stage '${stageInstanceId}' unit '${unitId}'`);
  const verified = await dependencies.pull_requests.find_current_for_unit(stageInstanceId, unitId);
  if (!verified) return failure("missing_pull_request_evidence", `unit '${unitId}' has no independently verified pull request`);
  const handoff = await dependencies.records.find_cohort_handoff(stageInstanceId, unitId);
  // From the cohort's own state, not the handoff record's join, so there is one
  // answer to "which run owns this cohort" whether a handoff exists or not.
  const run_id = await runIdOf(dependencies, cohort.cohort_id);
  if (!run_id) return failure("cohort_not_found", `cohort '${cohort.cohort_id}' belongs to no run`);

  return ok({
    cohort, handoff,
    expected: {
      run_id, stage_instance_id: stageInstanceId, unit_id: unitId,
      repository_key: cohort.repository_key,
      url: verified.pull_request.url,
      head_branch: cohort.canonical_ref,
      base_branch: cohort.expected_pr_base,
      forge_repository: { provider: "github", owner: verified.pull_request.owner, name: verified.pull_request.name },
    },
  });
};

const independentlyVerifyAndBind = async (
  dependencies: CohortPullRequestDependencies,
  stageInstanceId: StageInstanceId,
  unitId: UnitId,
  candidateUrl: string,
  replaceVerificationId: PullRequestVerificationId | null,
): Promise<Result<BoundVerifiedCohortPullRequest, CohortPullRequestError>> => {
  const cohort = await dependencies.pull_requests.find_cohort_for_unit(stageInstanceId, unitId);
  if (!cohort) return failure("cohort_not_found", `no stored build cohort for stage '${stageInstanceId}' unit '${unitId}'`);
  const runId = await runIdOf(dependencies, cohort.cohort_id);
  if (!runId) return failure("cohort_not_found", `cohort '${cohort.cohort_id}' belongs to no run`);
  const target = await dependencies.forge_targets.find(runId, cohort.repository_key);
  if (!target) return failure("missing_pull_request_evidence", `repository '${cohort.repository_key}' has no forge identity`);
  const forgeRepository = target.forge_repository;
  const verified = await verifyAndBindCohortPullRequest({ pull_requests: dependencies.pull_requests,
    reader: dependencies.reader, git: dependencies.git, now: dependencies.now,
    record_build_event: dependencies.record_build_event }, {
    cohort, forge_repository: forgeRepository, candidate_url: candidateUrl,
    replace_verification_id: replaceVerificationId,
  });
  if (!verified.ok) {
    const replacement = verified.error.kind === "replacement_required" || verified.error.kind === "replacement_conflict";
    return failure("mismatch", verified.error.detail, {
      ...(replacement ? { current_verification_id: verified.error.current_verification_id } : {}),
    });
  }
  return ok(verified.value);
};

/** What a publication-time verification did, for a caller that only reports it. */
export type ReportedPullRequestOutcome =
  | { readonly kind: "verified"; readonly pull_request_url: string; readonly binding: BoundVerifiedCohortPullRequest["binding"] }
  /** No candidate URL and no stored one: this publication says nothing about a pull request. */
  | { readonly kind: "no_candidate" }
  /** The cohort is not a build cohort, or its repository has no forge identity. */
  | { readonly kind: "not_applicable"; readonly detail: string }
  | { readonly kind: "refused"; readonly detail: string };

export interface ReportedCohortPullRequest {
  readonly stage_instance_id: StageInstanceId;
  readonly unit_id: UnitId;
  readonly run_id: WorkflowRunId;
  /** The URL the publishing session reported, when it reported one. */
  readonly candidate_url: string | null;
}

export type ReportedPullRequestDependencies = Pick<CohortPullRequestDependencies,
  "pull_requests" | "forge_targets" | "reader" | "git" | "now" | "record_build_event">;

/**
 * Verifies the pull request a publishing build session reported, and tells the
 * cohort's machine what the check found.
 *
 * This is the only producer of `pull_request_verified` a build cohort has before
 * its gate. The poller cannot be it: `pollCohortPullRequests` sweeps cohorts
 * blocked on the *external* merge wait, which is two gates later, and its
 * reconciliation path needs a handoff record the build stage has not created yet.
 * Without this the third clause of `isBuildReviewReady` had nothing that could
 * ever satisfy it and every build cohort sat at `builder_active` with its work
 * published.
 *
 * The candidate URL is agent-supplied and that is the existing contract: it is a
 * *pointer*, and `verifyCohortPullRequest` checks it against the forge and against
 * origin's pushed head, neither of which the session can author. A verification
 * that fails records `pull_request_mismatch`, which is the machine's route back to
 * a correcting builder — so a wrong URL is answered, not ignored.
 *
 * Re-reporting the same pull request after more commits rebinds it rather than
 * demanding a replacement: same pull request, moved head. A *different* URL is a
 * replacement and is refused here exactly as `bind_verified` refuses it, which the
 * machine turns into a `replacement_pr` launch.
 */
export const verifyReportedCohortPullRequest = async (
  dependencies: ReportedPullRequestDependencies,
  input: ReportedCohortPullRequest,
): Promise<ReportedPullRequestOutcome> => {
  const cohort = await dependencies.pull_requests.find_cohort_for_unit(input.stage_instance_id, input.unit_id);
  if (!cohort) return { kind: "not_applicable", detail: `unit '${input.unit_id}' has no stored build cohort` };
  const current = await dependencies.pull_requests.find_current_for_unit(input.stage_instance_id, input.unit_id);
  const candidateUrl = input.candidate_url ?? current?.pull_request.url ?? null;
  if (candidateUrl === null) return { kind: "no_candidate" };
  const target = await dependencies.forge_targets.find(input.run_id, cohort.repository_key);
  if (!target) return { kind: "not_applicable", detail: `repository '${cohort.repository_key}' has no forge identity` };
  const samePullRequest = current !== undefined && current !== null && current.pull_request.url === candidateUrl;
  const verified = await verifyAndBindCohortPullRequest(dependencies, {
    cohort, forge_repository: target.forge_repository, candidate_url: candidateUrl,
    replace_verification_id: samePullRequest ? cohort.current_verified_pull_request_id : null,
  });
  return verified.ok
    ? { kind: "verified", pull_request_url: verified.value.observation.url, binding: verified.value.binding }
    : { kind: "refused", detail: verified.error.detail };
};

/** The cohort's expectations, for a caller that wants to observe it. */
export const findCohortPullRequestExpectation = async (
  dependencies: CohortPullRequestDependencies,
  stageInstanceId: StageInstanceId,
  unitId: UnitId,
): Promise<Result<ExpectedCohortPullRequest, CohortPullRequestError>> => {
  const loaded = await loadCohortContext(dependencies, stageInstanceId, unitId);
  return loaded.ok ? ok(loaded.value.expected) : loaded;
};

export const reconcileCohortEvidence = async (
  dependencies: CohortPullRequestDependencies,
  stageInstanceId: StageInstanceId,
  unitId: UnitId,
  evidence: CohortPullRequestEvidence,
): Promise<Result<ResolvedCohortPullRequest, CohortPullRequestError>> => {
  let verified: BoundVerifiedCohortPullRequest;
  if (evidence.kind === "observation") {
    const result = await independentlyVerifyAndBind(dependencies, stageInstanceId, unitId, evidence.observation.url, evidence.replace_verification_id ?? null);
    if (!result.ok) return result;
    verified = result.value;
  } else {
    const current = await dependencies.pull_requests.find_current_for_unit(stageInstanceId, unitId);
    if (!current) return failure("missing_pull_request_evidence", "cohort has no verified pull request to recheck");
    const result = await independentlyVerifyAndBind(dependencies, stageInstanceId, unitId, current.pull_request.url, null);
    if (!result.ok) return result;
    verified = result.value;
  }
  const loaded = await loadCohortContext(dependencies, stageInstanceId, unitId);
  if (!loaded.ok) return loaded;
  const { expected, handoff } = loaded.value;
  const now = dependencies.now();
  const current = await dependencies.pull_requests.find_current_for_unit(stageInstanceId, unitId);
  if (!current || !current.cohort.current_verified_pull_request_id) {
    return failure("missing_pull_request_evidence", "verified pull request link disappeared before reconciliation");
  }
  const observation = current.observation;
  const reconciled = reconcileCohortPullRequest({ expected, handoff_artifact_id: handoff?.handoff_artifact_id ?? null,
    observation, previous: null, reconciled_at: now });
  const verificationId = current.cohort.current_verified_pull_request_id;

  if (reconciled.outcome.kind === "mismatch") {
    await dependencies.record_build_event(current.cohort.cohort_id,
      { kind: "pull_request_mismatch", pull_request_url: observation.url });
    return failure("mismatch", reconciled.outcome.mismatch.detail, { reconciliation: reconciled.reconciliation,
      current_verification_id: verificationId });
  }
  if (Date.parse(observation.observed_at) > Date.parse(verified.observation.observed_at)) {
    return ok({ resolution: { kind: "ignored_stale" }, reconciliation: reconciled.reconciliation, verification_id: verificationId });
  }
  if (handoff?.handoff_slot_state === "released") {
    return ok({ resolution: { kind: "already_completed" }, reconciliation: { ...reconciled.reconciliation, completed_at: now }, verification_id: verificationId });
  }
  if (reconciled.outcome.kind === "waiting") {
    return ok({ resolution: { kind: "waiting" }, reconciliation: reconciled.reconciliation, verification_id: verificationId });
  }

  const idempotencyKey = evidence.kind === "operator_confirmation"
    ? evidence.idempotency_key
    : `forge:${current.pull_request.id}:${observation.merged_at}`;
  const closure = await dependencies.pull_requests.confirm_merge({ cohort_id: current.cohort.cohort_id,
    pull_request_id: current.pull_request.id, idempotency_key: idempotencyKey,
    merged_at: observation.merged_at!, confirmed_at: now });
  if (!closure.ok) return failure("mismatch", closure.error.detail, { reconciliation: reconciled.reconciliation,
    current_verification_id: verificationId });

  // The completion, in v15: the closure is recorded and the cohort's own machine
  // is told. No stage declares a handoff, so there is no external wait to close,
  // and `pull_request_merged` is the only thing that can move a cohort out of
  // `awaiting_merge`. Emitted on a replay too — if a first delivery failed after
  // the closure committed, the retry has to be able to deliver the fact.
  //
  // A merge that arrives before the assessor has approved needs no special case:
  // the machine records `is_pull_request_merged` and `assessment_review_approved`
  // then completes the cohort directly instead of parking it.
  await dependencies.record_build_event(current.cohort.cohort_id,
    { kind: "pull_request_merged", pull_request_url: observation.url });

  // A definition that *does* declare a handoff still has its wait closed, and a
  // wait that is missing or already closed is not a failure here: the machine has
  // been told, which is what completes the cohort.
  const completion = handoff === null ? null : await dependencies.records.complete_handoff_artifact({
    artifact_id: handoff.handoff_artifact_id, external_kind: GITHUB_REVIEW_WAIT,
    actor: evidence.kind === "operator_confirmation" ? "operator" : "poller:github",
    correlation_id: observation.url, decided_at: now });
  const runId = completion !== null && completion.kind !== "wait_not_found" && completion.kind !== "wait_conflict"
    ? completion.run_id : expected.run_id;
  await dependencies.send_run_wake?.(runId, `pull_request_merged:${runId}:${current.pull_request.id}`).catch(() => undefined);
  const resolution: CohortPullRequestResolution =
    completion !== null && (completion.kind === "wait_not_found" || completion.kind === "wait_conflict")
      ? { kind: "merged_not_awaiting", handoff_status: completion.kind }
      : closure.value.kind === "replayed" ? { kind: "already_completed" } : { kind: "completed" };
  return ok({ resolution, reconciliation: { ...reconciled.reconciliation, completed_at: now }, verification_id: verificationId });
};
