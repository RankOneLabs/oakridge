import type {
  EpicRepositoryBinding,
  EpicWorkflowProfile,
  EpicWorkflowProfileId,
  PullRequestReference,
} from "./epic";
import { err, ok, type Result } from "./primitives";
import { parseGithubPullRequestIdentity, pullRequestMismatch, repositoriesMatch, type PullRequestMismatch, type PullRequestObservation } from "./pull-request";

// The pull-request vocabulary is shared with cohort reconciliation; it is
// re-exported here so existing callers keep one import path.
export type { ObservedPullRequestState, PullRequestMismatch, PullRequestMismatchKind, PullRequestObservation, PullRequestObservationSource } from "./pull-request";
export { parseGithubPullRequestIdentity } from "./pull-request";

export interface FinalPullRequestReconciliation {
  readonly epic_profile_id: EpicWorkflowProfileId;
  readonly repository_key: string;
  readonly observation: PullRequestObservation;
  readonly mismatch: PullRequestMismatch | null;
  readonly merged_evidence_at: string | null;
  readonly confirmation_idempotency_key: string | null;
  readonly operator_comment: string | null;
  readonly confirmed_at: string | null;
  readonly updated_at: string;
}

export interface ConfirmFinalPullRequestRequest {
  readonly idempotency_key: string;
  readonly operator_comment?: string;
}

export type ObserveFinalPullRequestOutcome =
  | "waiting"
  | "completed"
  | "mismatch"
  | "ignored_stale"
  | "awaiting_external_confirmation";

export interface FinalPullRequestProjection {
  readonly outcome: ObserveFinalPullRequestOutcome | "already_completed";
  readonly profile: EpicWorkflowProfile;
  readonly reconciliation: FinalPullRequestReconciliation | null;
}

export interface FinalPullRequestDomainError {
  readonly operation: "observe_final_pull_request" | "confirm_final_pull_request";
  readonly kind:
    | "not_eligible"
    | "profile_not_found"
    | "repository_not_bound"
    | "missing_repository_identity"
    | "invalid_pull_request_url"
    | "invalid_idempotency_key"
    | "invalid_policy"
    | "missing_merged_evidence"
    | "idempotency_conflict";
  readonly detail: string;
}

export interface ObserveFinalPullRequestInput {
  readonly profile: EpicWorkflowProfile;
  readonly repository_key: string;
  readonly observation: PullRequestObservation;
  readonly previous: FinalPullRequestReconciliation | null;
  readonly is_final_integration_eligible: boolean;
  readonly updated_at: string;
}

export interface ConfirmFinalPullRequestInput {
  readonly profile: EpicWorkflowProfile;
  readonly repository_key: string;
  readonly reconciliation: FinalPullRequestReconciliation | null;
  readonly request: ConfirmFinalPullRequestRequest;
  readonly is_final_integration_eligible: boolean;
  readonly confirmed_at: string;
}

const replaceRepository = (
  profile: EpicWorkflowProfile,
  repositoryKey: string,
  transform: (repository: EpicRepositoryBinding) => EpicRepositoryBinding,
  updatedAt: string,
): EpicWorkflowProfile => {
  const repositories = profile.repositories.map((repository) =>
    repository.repository_key === repositoryKey ? transform(repository) : repository);
  const lifecycle_state = repositories.every((repository) => repository.final_merge_state === "merged")
    ? "completed"
    : "final_integration";
  return { ...profile, repositories, lifecycle_state, updated_at: updatedAt };
};

const pullRequestReferencesMatch = (left: PullRequestReference, observation: PullRequestObservation): boolean => {
  const leftIdentity = parseGithubPullRequestIdentity(left.url);
  const rightIdentity = parseGithubPullRequestIdentity(observation.url);
  return left.number === observation.number
    && leftIdentity !== null
    && rightIdentity !== null
    && leftIdentity.number === rightIdentity.number
    && repositoriesMatch(leftIdentity.owner, leftIdentity.name, rightIdentity.owner, rightIdentity.name);
};

export const observeFinalPullRequest = (
  input: ObserveFinalPullRequestInput,
): Result<FinalPullRequestProjection, FinalPullRequestDomainError> => {
  const operation = "observe_final_pull_request" as const;
  if (!input.is_final_integration_eligible) return err({ operation, kind: "not_eligible", detail: "final integration requires every build cohort and assessment to be complete" });
  const repository = input.profile.repositories.find((candidate) => candidate.repository_key === input.repository_key);
  if (!repository) return err({ operation, kind: "repository_not_bound", detail: "repository is not bound to the Epic" });
  if (repository.final_merge_state === "merged") return ok({ outcome: "already_completed", profile: input.profile, reconciliation: input.previous });
  if (!repository.forge_repository) return err({ operation, kind: "missing_repository_identity", detail: "Epic repository has no durable forge identity" });
  const urlIdentity = parseGithubPullRequestIdentity(input.observation.url);
  if (!urlIdentity) return err({ operation, kind: "invalid_pull_request_url", detail: "observation URL is not a canonical GitHub PR URL" });
  if (input.previous && Date.parse(input.previous.observation.observed_at) > Date.parse(input.observation.observed_at)) {
    return ok({ outcome: "ignored_stale", profile: input.profile, reconciliation: input.previous });
  }

  // The final pull request carries the epic's work home: its head is the run's
  // base branch, and its base is where that branch was cut from.
  const reference = repository.final_pull_request ?? {
    number: urlIdentity.number,
    url: input.observation.url,
    head_branch: input.profile.base_branch,
    base_branch: repository.integration_branch,
  };
  let finding: PullRequestMismatch | null = null;
  if (!repositoriesMatch(urlIdentity.owner, urlIdentity.name, repository.forge_repository.owner, repository.forge_repository.name)) {
    finding = pullRequestMismatch("repository_mismatch", "final pull request URL does not belong to the Epic repository binding");
  } else if (!repositoriesMatch(input.observation.owner, input.observation.name, repository.forge_repository.owner, repository.forge_repository.name)) {
    finding = pullRequestMismatch("repository_mismatch", "observed pull request belongs to another repository");
  } else if (!pullRequestReferencesMatch(reference, input.observation)) {
    finding = pullRequestMismatch("pull_request_mismatch", "observed pull request does not match the build's durable PR identity");
  } else if (input.observation.head_branch !== input.profile.base_branch) {
    finding = pullRequestMismatch("head_branch_mismatch", "observed pull request head branch does not match the epic's base branch");
  } else if (input.observation.base_branch !== repository.integration_branch) {
    finding = pullRequestMismatch("base_branch_mismatch", "observed pull request base branch does not match the repository integration branch");
  } else if (input.observation.state === "closed_unmerged") {
    finding = pullRequestMismatch("closed_without_merge", "pull request closed without merging into the integration branch");
  } else if (input.observation.state === "merged" && input.observation.merged_at === null) {
    finding = pullRequestMismatch("pull_request_mismatch", "merged observation is missing merged_at evidence");
  }

  const hasMergedEvidence = finding === null && input.observation.state === "merged";
  const reconciliation: FinalPullRequestReconciliation = {
    epic_profile_id: input.profile.id,
    repository_key: input.repository_key,
    observation: input.observation,
    mismatch: finding,
    merged_evidence_at: hasMergedEvidence ? input.observation.merged_at : input.previous?.merged_evidence_at ?? null,
    confirmation_idempotency_key: input.previous?.confirmation_idempotency_key ?? null,
    operator_comment: input.previous?.operator_comment ?? null,
    confirmed_at: input.previous?.confirmed_at ?? null,
    updated_at: input.updated_at,
  };
  const shouldRegisterReference = finding === null || finding.kind === "closed_without_merge";
  const nextState = finding?.kind === "closed_without_merge"
    ? "closed_without_merge"
    : finding !== null
      ? repository.final_merge_state
      : input.observation.state === "open"
        ? "pull_request_open"
        : input.profile.final_merge_policy === "guarded" ? "merged" : "awaiting_confirmation";
  const profile = replaceRepository(input.profile, input.repository_key, (current) => ({
    ...current,
    final_pull_request: shouldRegisterReference ? reference : current.final_pull_request,
    final_merge_state: nextState,
  }), input.updated_at);
  const outcome: ObserveFinalPullRequestOutcome = finding !== null
    ? "mismatch"
    : input.observation.state === "open"
      ? "waiting"
      : input.profile.final_merge_policy === "guarded" ? "completed" : "awaiting_external_confirmation";
  return ok({ outcome, profile, reconciliation });
};

export const confirmFinalPullRequest = (
  input: ConfirmFinalPullRequestInput,
): Result<FinalPullRequestProjection, FinalPullRequestDomainError> => {
  const operation = "confirm_final_pull_request" as const;
  if (input.request.idempotency_key.trim() === "") return err({ operation, kind: "invalid_idempotency_key", detail: "idempotency_key must not be empty" });
  if (!input.is_final_integration_eligible) return err({ operation, kind: "not_eligible", detail: "final integration requires every build cohort and assessment to be complete" });
  if (input.profile.final_merge_policy !== "external_confirmation") return err({ operation, kind: "invalid_policy", detail: "explicit confirmation is only valid for external_confirmation policy" });
  if (!input.reconciliation?.merged_evidence_at) return err({ operation, kind: "missing_merged_evidence", detail: "final pull request has no durable merged evidence" });
  if (input.reconciliation.confirmation_idempotency_key !== null
      && input.reconciliation.confirmation_idempotency_key !== input.request.idempotency_key) {
    return err({ operation, kind: "idempotency_conflict", detail: "final pull request was confirmed with a different idempotency key" });
  }
  if (!input.profile.repositories.some((repository) => repository.repository_key === input.repository_key)) {
    return err({ operation, kind: "repository_not_bound", detail: "repository is not bound to the Epic" });
  }
  const reconciliation: FinalPullRequestReconciliation = {
    ...input.reconciliation,
    confirmation_idempotency_key: input.request.idempotency_key,
    operator_comment: input.request.operator_comment ?? null,
    confirmed_at: input.reconciliation.confirmed_at ?? input.confirmed_at,
    updated_at: input.confirmed_at,
  };
  const profile = replaceRepository(input.profile, input.repository_key, (repository) => ({
    ...repository,
    final_merge_state: "merged",
  }), input.confirmed_at);
  return ok({ outcome: "completed", profile, reconciliation });
};
