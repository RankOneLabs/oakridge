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

function FinalRepositoryCard({
  runId,
  policy,
  repository,
}: {
  runId: string;
  policy: EpicWorkflowProfile["final_merge_policy"];
  repository: EpicRepositoryBinding;
}) {
  const confirmation = useConfirmFinalPullRequest(runId, repository.repository_key);
  const confirmationKey = useRef(crypto.randomUUID());
  const canConfirm = policy === "external_confirmation" && repository.final_merge_state === "awaiting_confirmation";

  return (
    <article className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-4" data-testid={`or-final-repository-${repository.repository_key}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="m-0 text-sm font-semibold text-[var(--text-primary)]">{repository.repository_key}</h4>
          <p className="mb-0 mt-1 text-xs text-[var(--text-muted)]">
            <code>{repository.epic_branch}</code> → <code>{repository.base_branch}</code>
          </p>
        </div>
        <span className="rounded-full border border-[var(--border-muted)] px-2 py-1 text-xs text-[var(--text-secondary)]">
          {stateLabels[repository.final_merge_state]}
        </span>
      </div>

      {repository.final_pull_request ? (
        <p className="mb-0 mt-3 text-sm">
          <a href={repository.final_pull_request.url} target="_blank" rel="noreferrer">
            Final PR #{repository.final_pull_request.number}
          </a>
          <span className="ml-2 text-[var(--text-muted)]">
            {repository.final_pull_request.head_branch} → {repository.final_pull_request.base_branch}
          </span>
        </p>
      ) : (
        <p className="mb-0 mt-3 text-sm text-[var(--text-muted)]">No final pull request has been observed yet.</p>
      )}

      {canConfirm && (
        <div className="mt-3 flex flex-col items-start gap-2">
          <p className="m-0 text-xs text-[var(--text-muted)]">
            Confirm only after this exact PR is merged. Oakridge verifies stored merged evidence; it does not merge the PR.
          </p>
          <button
            type="button"
            className="rounded-md border border-[var(--accent-blue)] px-3 py-1.5 text-sm text-[var(--accent-blue)] disabled:opacity-50"
            disabled={confirmation.isPending}
            onClick={() => confirmation.mutate({ idempotency_key: confirmationKey.current })}
            data-testid={`or-confirm-final-${repository.repository_key}`}
          >
            {confirmation.isPending ? "Confirming…" : "Confirm external completion"}
          </button>
        </div>
      )}

      {confirmation.isError && (
        <p className="mb-0 mt-2 text-sm text-[var(--danger-fg)]" role="alert">
          {confirmation.error instanceof Error ? confirmation.error.message : "Final confirmation failed"}
        </p>
      )}
    </article>
  );
}

export function FinalIntegrationPanel({ runId, profile }: { runId: string; profile: EpicWorkflowProfile }) {
  return (
    <section className="flex flex-col gap-3" aria-labelledby="or-final-integration-title" data-testid="or-final-integration">
      <div>
        <h3 id="or-final-integration-title" className="mb-1 mt-0 text-sm font-semibold text-[var(--text-secondary)]">
          Epic integration
        </h3>
        <p className="m-0 text-xs text-[var(--text-muted)]">
          {profile.title} · {profile.lifecycle_state.replaceAll("_", " ")} · {profile.final_merge_policy.replaceAll("_", " ")} policy
        </p>
      </div>
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,20rem),1fr))]">
        {profile.repositories.map((repository) => (
          <FinalRepositoryCard
            key={repository.repository_key}
            runId={runId}
            policy={profile.final_merge_policy}
            repository={repository}
          />
        ))}
      </div>
    </section>
  );
}
