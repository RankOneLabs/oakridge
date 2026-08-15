import { expect, test } from "bun:test";

import type { EpicWorkflowProfile, EpicWorkflowProfileId } from "../src/domain/epic";
import {
  confirmFinalPullRequest,
  observeFinalPullRequest,
  parseGithubPullRequestIdentity,
  type FinalPullRequestReconciliation,
  type PullRequestObservation,
} from "../src/domain/final-pull-request";
import type { WorkflowRunId } from "../src/domain/primitives";

const profile = (policy: EpicWorkflowProfile["final_merge_policy"] = "external_confirmation"): EpicWorkflowProfile => ({
  id: "00000000-0000-0000-0000-000000000001" as EpicWorkflowProfileId,
  workflow_run_id: "00000000-0000-0000-0000-000000000002" as WorkflowRunId,
  title: "Epic", slug: "epic", lifecycle_state: "final_integration", final_merge_policy: policy,
  repositories: ["api", "web"].map((repository_key) => ({
    repository_key, repository_path: `/repos/${repository_key}`, base_branch: "main", epic_branch: "epic/parity",
    forge_repository: { provider: "github", owner: "acme", name: repository_key }, final_pull_request: null, final_merge_state: "pending",
  })),
  created_at: "2026-08-15T00:00:00Z", updated_at: "2026-08-15T00:00:00Z",
});

const observation = (overrides: Partial<PullRequestObservation> = {}): PullRequestObservation => ({
  provider: "github", owner: "acme", name: "api", number: 42, url: "https://github.com/acme/api/pull/42",
  head_branch: "epic/parity", base_branch: "main", head_sha: "abc", state: "merged", source: "webhook",
  observed_at: "2026-08-15T01:00:00Z", merged_at: "2026-08-15T01:00:00Z", ...overrides,
});

const reconciliation = (overrides: Partial<FinalPullRequestReconciliation> = {}): FinalPullRequestReconciliation => ({
  epic_profile_id: profile().id, repository_key: "api", observation: observation(), mismatch: null,
  merged_evidence_at: "2026-08-15T01:00:00Z", confirmation_idempotency_key: null, operator_comment: null,
  confirmed_at: null, updated_at: "2026-08-15T01:00:00Z", ...overrides,
});

test("canonical GitHub pull request identity accepts only the exact URL shape", () => {
  expect(parseGithubPullRequestIdentity("https://github.com/acme/api/pull/42/")).toEqual({ owner: "acme", name: "api", number: 42 });
  for (const invalid of ["http://github.com/acme/api/pull/42", "https://github.com/acme/api/issues/42", "https://github.com/acme/api/pull/0", "https://github.com/acme/api/pull/42/files"]) {
    expect(parseGithubPullRequestIdentity(invalid)).toBeNull();
  }
});

test("merged evidence projects external confirmation without completing the Epic", () => {
  const result = observeFinalPullRequest({ profile: profile(), repository_key: "api", observation: observation(), previous: null, is_final_integration_eligible: true, updated_at: "2026-08-15T01:01:00Z" });
  expect(result).toEqual({ ok: true, value: expect.objectContaining({
    outcome: "awaiting_external_confirmation",
    profile: expect.objectContaining({ lifecycle_state: "final_integration", repositories: [expect.objectContaining({ repository_key: "api", final_merge_state: "awaiting_confirmation", final_pull_request: expect.objectContaining({ number: 42 }) }), expect.anything()] }),
    reconciliation: expect.objectContaining({ merged_evidence_at: "2026-08-15T01:00:00Z" }),
  }) });
});

test("observation rejects mismatched identity and ignores older durable evidence", () => {
  const mismatch = observeFinalPullRequest({ profile: profile(), repository_key: "api", observation: observation({ name: "web", url: "https://github.com/acme/web/pull/42" }), previous: null, is_final_integration_eligible: true, updated_at: "2026-08-15T01:01:00Z" });
  expect(mismatch.ok && mismatch.value.reconciliation?.mismatch?.kind).toBe("repository_mismatch");
  const previous = reconciliation({ observation: observation({ observed_at: "2026-08-15T03:00:00Z" }) });
  const stale = observeFinalPullRequest({ profile: profile(), repository_key: "api", observation: observation(), previous, is_final_integration_eligible: true, updated_at: "2026-08-15T04:00:00Z" });
  expect(stale).toEqual({ ok: true, value: { outcome: "ignored_stale", profile: profile(), reconciliation: previous } });
});

test("staleness compares instants rather than timestamp string formatting", () => {
  const previous = reconciliation({ observation: observation({ observed_at: "2026-08-15T02:00:00-07:00" }) });
  const stale = observeFinalPullRequest({
    profile: profile(), repository_key: "api", observation: observation({ observed_at: "2026-08-15T08:30:00Z" }),
    previous, is_final_integration_eligible: true, updated_at: "2026-08-15T10:00:00Z",
  });
  expect(stale.ok && stale.value.outcome).toBe("ignored_stale");
});

test("confirmation is replay-safe and completes only after the final repository", () => {
  const first = confirmFinalPullRequest({ profile: profile(), repository_key: "api", reconciliation: reconciliation(), request: { idempotency_key: "confirm-api", operator_comment: "verified" }, is_final_integration_eligible: true, confirmed_at: "2026-08-15T02:00:00Z" });
  expect(first.ok && first.value.profile.lifecycle_state).toBe("final_integration");
  if (!first.ok || !first.value.reconciliation) throw new Error("expected confirmation");
  const replay = confirmFinalPullRequest({ profile: first.value.profile, repository_key: "api", reconciliation: first.value.reconciliation, request: { idempotency_key: "confirm-api" }, is_final_integration_eligible: true, confirmed_at: "2026-08-15T03:00:00Z" });
  expect(replay.ok && replay.value.reconciliation?.confirmed_at).toBe("2026-08-15T02:00:00Z");
  expect(replay.ok && replay.value.reconciliation?.operator_comment).toBeNull();
  const webReady = replay.ok ? { ...replay.value.profile, repositories: replay.value.profile.repositories.map((repository) => repository.repository_key === "web" ? { ...repository, final_merge_state: "awaiting_confirmation" as const } : repository) } : profile();
  const last = confirmFinalPullRequest({ profile: webReady, repository_key: "web", reconciliation: reconciliation({ repository_key: "web", observation: observation({ name: "web", url: "https://github.com/acme/web/pull/42" }) }), request: { idempotency_key: "confirm-web" }, is_final_integration_eligible: true, confirmed_at: "2026-08-15T04:00:00Z" });
  expect(last.ok && last.value.profile.lifecycle_state).toBe("completed");
});

test("confirmation enforces eligibility, policy, evidence, repository, and idempotency", () => {
  const base = { profile: profile(), repository_key: "api", reconciliation: reconciliation(), request: { idempotency_key: "confirm-api" }, is_final_integration_eligible: true, confirmed_at: "2026-08-15T02:00:00Z" };
  expect(confirmFinalPullRequest({ ...base, request: { idempotency_key: " " } })).toEqual({ ok: false, error: expect.objectContaining({ kind: "invalid_idempotency_key" }) });
  expect(confirmFinalPullRequest({ ...base, is_final_integration_eligible: false })).toEqual({ ok: false, error: expect.objectContaining({ kind: "not_eligible" }) });
  expect(confirmFinalPullRequest({ ...base, profile: profile("guarded") })).toEqual({ ok: false, error: expect.objectContaining({ kind: "invalid_policy" }) });
  expect(confirmFinalPullRequest({ ...base, reconciliation: null })).toEqual({ ok: false, error: expect.objectContaining({ kind: "missing_merged_evidence" }) });
  expect(confirmFinalPullRequest({ ...base, repository_key: "docs" })).toEqual({ ok: false, error: expect.objectContaining({ kind: "repository_not_bound" }) });
  expect(confirmFinalPullRequest({ ...base, reconciliation: reconciliation({ confirmation_idempotency_key: "other" }) })).toEqual({ ok: false, error: expect.objectContaining({ kind: "idempotency_conflict" }) });
});
