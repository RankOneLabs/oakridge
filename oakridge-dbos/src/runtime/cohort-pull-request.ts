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
import {
  reconcileCohortPullRequest, reconciliationForHandoff, withCompletion,
  type CohortPullRequestOutcome, type CohortPullRequestReconciliation, type DevFlowBuildCohort, type ExpectedCohortPullRequest,
} from "../domain/cohort-pull-request";
import { err, ok, type ArtifactId, type Result, type StageInstanceId, type UnitId, type WorkflowRunId } from "../domain/primitives";
import type { PullRequestObservation } from "../domain/pull-request";
import { parseGithubPullRequestIdentity, repositoriesMatch, type PullRequestVerificationId } from "../domain/pull-request";
import type { GitCommandRunner } from "../domain/repository-provisioning";
import type { CohortPullRequestRepository, DevFlowPullRequestRepository, EpicWorkflowProfileRepository, RunRecordRepository } from "../storage/repositories";

const GITHUB_REVIEW_WAIT = "github_review";

export interface CohortPullRequestDependencies {
  readonly pull_requests: DevFlowPullRequestRepository;
  readonly epic_profiles: EpicWorkflowProfileRepository;
  readonly reader: PullRequestForgeReader;
  readonly git: GitCommandRunner;
  readonly reconciliations: CohortPullRequestRepository;
  readonly records: Pick<RunRecordRepository, "find_cohort_handoff" | "complete_handoff_artifact">;
  readonly now: () => string;
  /** Wakes the run's root sooner than its bounded recheck once a merge releases the handoff — a hint, never a decision. */
  readonly send_run_wake?: (run_id: WorkflowRunId, idempotency_key: string) => Promise<void>;
}

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

export interface AdvanceCohortRefInput { readonly cohort: DevFlowBuildCohort; readonly next_head_sha: string }
export interface CohortRefAdvanceError {
  readonly operation: "advance_cohort_ref";
  readonly kind: "ref_lease_mismatch" | "non_descendant_head" | "git_command_failed";
  readonly detail: string;
}
const refAdvanceFailure = (kind: CohortRefAdvanceError["kind"], detail: string): Result<never, CohortRefAdvanceError> =>
  err({ operation: "advance_cohort_ref", kind, detail });

/** An ancestry check protects reviewed work; the push lease protects the check itself. */
export const advanceCohortRef = async (
  git: GitCommandRunner,
  input: AdvanceCohortRefInput,
): Promise<Result<{ readonly head_sha: string }, CohortRefAdvanceError>> => {
  const ref = `refs/heads/${input.cohort.canonical_ref}`;
  const remote = await git.run(input.cohort.repository_path, ["ls-remote", "origin", ref]);
  if (remote.exit_code !== 0) return refAdvanceFailure("git_command_failed", remote.stderr.trim() || "could not read origin ref");
  const remoteHead = remote.stdout.trim().split(/\s+/)[0] ?? "";
  if (remoteHead !== input.cohort.recorded_head_sha) {
    return refAdvanceFailure("ref_lease_mismatch", `origin moved from recorded head '${input.cohort.recorded_head_sha}' to '${remoteHead || "missing"}'`);
  }
  const ancestry = await git.run(input.cohort.repository_path, ["merge-base", "--is-ancestor", input.cohort.recorded_head_sha, input.next_head_sha]);
  if (ancestry.exit_code === 1) return refAdvanceFailure("non_descendant_head", "next cohort head does not descend from the recorded head");
  if (ancestry.exit_code !== 0) return refAdvanceFailure("git_command_failed", ancestry.stderr.trim() || "could not check cohort ref ancestry");
  const pushed = await git.run(input.cohort.repository_path, ["push", `--force-with-lease=${ref}:${input.cohort.recorded_head_sha}`, "origin", `${input.next_head_sha}:${ref}`]);
  if (pushed.exit_code !== 0) return refAdvanceFailure("ref_lease_mismatch", pushed.stderr.trim() || "origin refused the cohort ref lease");
  return ok({ head_sha: input.next_head_sha });
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
}

/**
 * What became of the evidence.
 *
 * `merged_not_awaiting` is a real state, not a failure: a pull request can
 * merge before the assessor has approved it. The merge is recorded and the wait
 * closes on a later observation, once there is a wait to close.
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
}

const failure = (kind: CohortPullRequestError["kind"], detail: string, reconciliation?: CohortPullRequestReconciliation): Result<never, CohortPullRequestError> =>
  err({ operation: "reconcile_cohort_pull_request", kind, detail, ...(reconciliation ? { reconciliation } : {}) });

interface CohortHandoff {
  readonly expected: ExpectedCohortPullRequest;
  readonly handoff_artifact_id: ArtifactId;
  readonly handoff_slot_state: "empty" | "pending" | "released" | "invalidated";
}

/** Everything the run already knows about this cohort's pull request. */
const loadCohortHandoff = async (
  dependencies: CohortPullRequestDependencies,
  stageInstanceId: StageInstanceId,
  unitId: UnitId,
): Promise<Result<CohortHandoff, CohortPullRequestError>> => {
  const record = await dependencies.records.find_cohort_handoff(stageInstanceId, unitId);
  if (!record) return failure("cohort_not_found", `no run-owned handoff for stage '${stageInstanceId}' unit '${unitId}'`);
  const verified = await dependencies.pull_requests.find_current_for_unit(stageInstanceId, unitId);
  if (!verified) return failure("missing_pull_request_evidence", `unit '${unitId}' has no independently verified pull request`);

  return ok({
    handoff_artifact_id: record.handoff_artifact_id,
    handoff_slot_state: record.handoff_slot_state,
    expected: {
      run_id: record.run_id, stage_instance_id: record.stage_instance_id, unit_id: record.unit_id,
      repository_key: verified.cohort.repository_key,
      url: verified.pull_request.url,
      head_branch: verified.cohort.canonical_ref,
      base_branch: verified.cohort.expected_pr_base,
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
): Promise<Result<PullRequestObservation, CohortPullRequestError>> => {
  const handoff = await dependencies.records.find_cohort_handoff(stageInstanceId, unitId);
  const cohort = await dependencies.pull_requests.find_cohort_for_unit(stageInstanceId, unitId);
  if (!handoff || !cohort) return failure("cohort_not_found", `no stored build cohort for stage '${stageInstanceId}' unit '${unitId}'`);
  const profile = await dependencies.epic_profiles.find_by_run_id(handoff.run_id);
  const forgeRepository = profile?.repositories.find((repository) => repository.repository_key === cohort.repository_key)?.forge_repository ?? null;
  if (!forgeRepository) return failure("missing_pull_request_evidence", `repository '${cohort.repository_key}' has no forge identity`);
  const verified = await verifyCohortPullRequest({ reader: dependencies.reader, git: dependencies.git }, {
    cohort, forge_repository: forgeRepository, candidate_url: candidateUrl,
  });
  if (!verified.ok) return failure("mismatch", verified.error.detail);
  const current = await dependencies.pull_requests.find_current_for_unit(stageInstanceId, unitId);
  const stored = await dependencies.pull_requests.observe({ repository_key: cohort.repository_key,
    observation: verified.value.observation, recorded_at: dependencies.now() });
  const isSameVerifiedHead = current?.pull_request.id === stored.pull_request_id
    && current.observation.head_sha === verified.value.pushed_head_sha;
  if (!isSameVerifiedHead) {
    const bound = await dependencies.pull_requests.bind_verified({ cohort_id: cohort.cohort_id, ...stored,
      verified_head_sha: verified.value.pushed_head_sha, verified_at: dependencies.now(), replace_verification_id: replaceVerificationId });
    if (!bound.ok) return failure("mismatch", bound.error.detail);
  }
  return ok(verified.value.observation);
};

/** The cohort's expectations, for a caller that wants to observe it. */
export const findCohortPullRequestExpectation = async (
  dependencies: CohortPullRequestDependencies,
  stageInstanceId: StageInstanceId,
  unitId: UnitId,
): Promise<Result<ExpectedCohortPullRequest, CohortPullRequestError>> => {
  const loaded = await loadCohortHandoff(dependencies, stageInstanceId, unitId);
  return loaded.ok ? ok(loaded.value.expected) : loaded;
};

export const reconcileCohortEvidence = async (
  dependencies: CohortPullRequestDependencies,
  stageInstanceId: StageInstanceId,
  unitId: UnitId,
  evidence: CohortPullRequestEvidence,
): Promise<Result<ResolvedCohortPullRequest, CohortPullRequestError>> => {
  let verifiedObservation: PullRequestObservation;
  if (evidence.kind === "observation") {
    const verified = await independentlyVerifyAndBind(dependencies, stageInstanceId, unitId, evidence.observation.url, evidence.replace_verification_id ?? null);
    if (!verified.ok) return verified;
    verifiedObservation = verified.value;
  } else {
    const current = await dependencies.pull_requests.find_current_for_unit(stageInstanceId, unitId);
    if (!current) return failure("missing_pull_request_evidence", "cohort has no verified pull request to recheck");
    const verified = await independentlyVerifyAndBind(dependencies, stageInstanceId, unitId, current.pull_request.url, null);
    if (!verified.ok) return verified;
    verifiedObservation = verified.value;
  }
  const loaded = await loadCohortHandoff(dependencies, stageInstanceId, unitId);
  if (!loaded.ok) return loaded;
  const { expected, handoff_artifact_id: handoffArtifactId, handoff_slot_state: handoffSlotState } = loaded.value;

  const now = dependencies.now();
  const observation = verifiedObservation;

  const previous = reconciliationForHandoff(
    await dependencies.reconciliations.find(expected.stage_instance_id, expected.unit_id), handoffArtifactId, handoffSlotState);
  const reconciled = reconcileCohortPullRequest({ expected, handoff_artifact_id: handoffArtifactId, observation, previous, reconciled_at: now });
  const outcome: CohortPullRequestOutcome = reconciled.outcome;

  if (outcome.kind === "mismatch") {
    await dependencies.reconciliations.upsert(reconciled.reconciliation);
    return failure("mismatch", outcome.mismatch.detail, reconciled.reconciliation);
  }
  if (outcome.kind === "ignored_stale") return ok({ resolution: { kind: "ignored_stale" }, reconciliation: reconciled.reconciliation });
  if (outcome.kind === "already_completed") return ok({ resolution: { kind: "already_completed" }, reconciliation: reconciled.reconciliation });
  if (outcome.kind === "waiting") {
    await dependencies.reconciliations.upsert(reconciled.reconciliation);
    return ok({ resolution: { kind: "waiting" }, reconciliation: reconciled.reconciliation });
  }

  const completion = await dependencies.records.complete_handoff_artifact({ artifact_id: handoffArtifactId,
    external_kind: GITHUB_REVIEW_WAIT, actor: evidence.kind === "operator_confirmation" ? "operator" : "poller:github",
    correlation_id: observation.url, decided_at: now });
  if (completion.kind === "wait_not_found" || completion.kind === "wait_conflict") {
    // Merged, but there is no wait open to close — the assessor has not
    // approved yet, or something already closed it. Recorded either way; the
    // next observation completes it once the wait exists.
    await dependencies.reconciliations.upsert(reconciled.reconciliation);
    return ok({ resolution: { kind: "merged_not_awaiting", handoff_status: completion.kind }, reconciliation: reconciled.reconciliation });
  }
  const completed = withCompletion(reconciled.reconciliation, now);
  await dependencies.reconciliations.upsert(completed);
  await dependencies.send_run_wake?.(completion.run_id, `${completion.kind}:${completion.run_id}:${completion.record_version}`).catch(() => undefined);
  return ok({ resolution: { kind: "completed" }, reconciliation: completed });
};
