import { useRef } from "react";

import { useConfirmFinalPullRequest } from "../../hooks/useConfirmFinalPullRequest";
import type { EpicRepositoryBinding, EpicWorkflowProfile } from "../../types";

const stateLabels = {
  pending: "Waiting for final PR",
  pull_request_open: "Final PR in progress",
  awaiting_confirmation: "Awaiting external confirmation",
  merged: "Complete",
  closed_without_merge: "Closed without merge",
} as const;

interface FinalRepositoryCardProps {
  runId: string;
  policy: EpicWorkflowProfile["final_merge_policy"];
  /** The epic's one base branch — the head of every final pull request. */
  baseBranch: string;
  repository: EpicRepositoryBinding;
}

function FinalRepositoryCard({ runId, policy, baseBranch, repository }: FinalRepositoryCardProps) {
  const confirmation = useConfirmFinalPullRequest(runId, repository.repository_key);
  const confirmationKey = useRef(crypto.randomUUID());
  const canConfirm = policy === "external_confirmation" && repository.final_merge_state === "awaiting_confirmation";

  return (
    <article className="or-final-repository" data-testid={`or-final-repository-${repository.repository_key}`}>
      <div className="or-final-repository__header">
        <div>
          <h4 className="or-final-repository__title">{repository.repository_key}</h4>
          <p className="or-final-repository__branches">
            <code>{baseBranch}</code> → <code>{repository.integration_branch}</code>
          </p>
        </div>
        <span className="or-final-repository__state">
          {stateLabels[repository.final_merge_state]}
        </span>
      </div>

      {repository.final_pull_request ? (
        <p className="or-final-repository__pr">
          <a href={repository.final_pull_request.url} target="_blank" rel="noreferrer">
            Final PR #{repository.final_pull_request.number}
          </a>
          <span className="or-final-repository__pr-branches">
            {repository.final_pull_request.head_branch} → {repository.final_pull_request.base_branch}
          </span>
        </p>
      ) : (
        <p className="or-final-repository__empty">No final pull request has been observed yet.</p>
      )}

      {canConfirm && (
        <div className="or-final-repository__confirmation">
          <p className="or-final-repository__hint">
            Confirm only after this exact PR is merged. Oakridge verifies stored merged evidence; it does not merge the PR.
          </p>
          <button
            type="button"
            className="or-final-repository__confirm"
            disabled={confirmation.isPending}
            onClick={() => confirmation.mutate({ idempotency_key: confirmationKey.current })}
            data-testid={`or-confirm-final-${repository.repository_key}`}
          >
            {confirmation.isPending ? "Confirming…" : "Confirm external completion"}
          </button>
        </div>
      )}

      {confirmation.isError && (
        <p className="or-final-repository__error" role="alert">
          {confirmation.error instanceof Error ? confirmation.error.message : "Final confirmation failed"}
        </p>
      )}
    </article>
  );
}

export function FinalIntegrationPanel({ runId, profile }: { runId: string; profile: EpicWorkflowProfile }) {
  return (
    <section className="or-final-integration" aria-labelledby="or-final-integration-title" data-testid="or-final-integration">
      <div>
        <h3 id="or-final-integration-title" className="or-final-integration__title">
          Epic integration
        </h3>
        <p className="or-final-integration__summary">
          {profile.title} · {profile.lifecycle_state.replaceAll("_", " ")} · {profile.final_merge_policy.replaceAll("_", " ")} policy
        </p>
      </div>
      <div className="or-final-integration__grid">
        {profile.repositories.map((repository) => (
          <FinalRepositoryCard
            key={repository.repository_key}
            runId={runId}
            policy={profile.final_merge_policy}
            baseBranch={profile.base_branch}
            repository={repository}
          />
        ))}
      </div>
    </section>
  );
}
