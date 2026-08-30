/**
 * Closing a cohort's `github_review` wait on evidence that its pull request
 * merged.
 *
 * A build unit's `build_result` is released through a handoff whose external
 * wait is `github_review`. Two participants can supply the evidence and both
 * arrive here: the poller, which reports what GitHub says, and an operator
 * confirming by hand when the poller cannot see the repository. They differ
 * only in the observation's `source` — the same expectations are checked
 * against both, so a human clicking a button is not a way around them.
 *
 * The wait is named `github_review` and the evidence is a pull request, so this
 * reads the cohort's `dev.pr_summary` artifact for the URL and branch the build
 * reported. That coupling is the feature, not an oversight: an external wait of
 * some other kind would be satisfied by some other evidence and would not come
 * through here.
 */
import {
  operatorMergedObservation, reconcileCohortPullRequest, withCompletion,
  type CohortPullRequestOutcome, type CohortPullRequestReconciliation, type ExpectedCohortPullRequest,
} from "../domain/cohort-pull-request";
import type { BuildResultBody, PrSummaryBody } from "../domain/dev-flow-artifacts";
import type { EpicWorkflowProfile } from "../domain/epic";
import { err, ok, type ArtifactId, type JsonValue, type Result, type StageInstanceId, type UnitId, type WorkflowRunId } from "../domain/primitives";
import type { PullRequestObservation } from "../domain/pull-request";
import type { CohortPullRequestRepository, EpicWorkflowProfileRepository, RunRecordRepository, WorkflowRunRepository } from "../storage/repositories";

const GITHUB_REVIEW_WAIT = "github_review";

export interface CohortPullRequestDependencies {
  readonly runs: WorkflowRunRepository;
  readonly epic_profiles: EpicWorkflowProfileRepository;
  readonly reconciliations: CohortPullRequestRepository;
  readonly records: Pick<RunRecordRepository, "find_cohort_handoff" | "complete_handoff_artifact">;
  readonly now: () => string;
  /** Wakes the run's root sooner than its bounded recheck once a merge releases the handoff — a hint, never a decision. */
  readonly send_run_wake?: (run_id: WorkflowRunId, idempotency_key: string) => Promise<void>;
}

/** How the evidence arrived. Both kinds are reconciled identically. */
export type CohortPullRequestEvidence =
  | { readonly kind: "observation"; readonly observation: PullRequestObservation }
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

const isObject = (value: JsonValue): value is { readonly [key: string]: JsonValue } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readString = (body: JsonValue, key: string): string | null => {
  if (!isObject(body)) return null;
  const value = body[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
};

/**
 * The branch a build unit's pull request should target: the run's base branch.
 *
 * One value, not a per-repository lookup — an epic builds on one branch, so
 * every unit in every repository targets the same name. An Epic profile is
 * authoritative; a run launched without one still declares it in its context.
 * Neither is guaranteed, and an expectation the run never stated is not one the
 * evidence can fail.
 */
const selectExpectedBaseBranch = (profile: EpicWorkflowProfile | null, runContext: JsonValue): string | null => {
  if (profile) return profile.base_branch;
  if (!isObject(runContext)) return null;
  return typeof runContext.base_branch === "string" ? runContext.base_branch : null;
};

interface CohortHandoff {
  readonly expected: ExpectedCohortPullRequest;
  readonly handoff_artifact_id: ArtifactId;
}

/** Everything the run already knows about this cohort's pull request. */
const loadCohortHandoff = async (
  dependencies: CohortPullRequestDependencies,
  stageInstanceId: StageInstanceId,
  unitId: UnitId,
): Promise<Result<CohortHandoff, CohortPullRequestError>> => {
  const record = await dependencies.records.find_cohort_handoff(stageInstanceId, unitId);
  if (!record) return failure("cohort_not_found", `no run-owned handoff for stage '${stageInstanceId}' unit '${unitId}'`);
  const summary = record.summary_body as unknown as PrSummaryBody;
  const url = readString(record.summary_body, "pr_url");
  const headBranch = readString(record.summary_body, "branch");
  if (!url || !headBranch) return failure("missing_pull_request_evidence", `unit '${unitId}' reported no pull request URL and branch: ${JSON.stringify(summary)}`);

  // The repository key rides on the build result, which is the artifact that
  // names what was built. Falling back to the unit id keeps the durable record
  // addressable for a definition that does not carry one.
  const repositoryKey = readString(record.handoff_body, "repository_key" satisfies keyof BuildResultBody) ?? record.repository_key;
  const run = await dependencies.runs.find_by_id(record.run_id);
  const profile = await dependencies.epic_profiles.find_by_run_id(record.run_id);
  const binding = profile?.repositories.find((candidate) => candidate.repository_key === repositoryKey) ?? null;

  return ok({
    handoff_artifact_id: record.handoff_artifact_id,
    expected: {
      run_id: record.run_id, stage_instance_id: record.stage_instance_id, unit_id: record.unit_id,
      repository_key: repositoryKey, url, head_branch: headBranch,
      base_branch: selectExpectedBaseBranch(profile ?? null, run?.context ?? null),
      forge_repository: binding?.forge_repository ?? null,
    },
  });
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
  const loaded = await loadCohortHandoff(dependencies, stageInstanceId, unitId);
  if (!loaded.ok) return loaded;
  const { expected, handoff_artifact_id: handoffArtifactId } = loaded.value;

  const now = dependencies.now();
  const observation = evidence.kind === "observation" ? evidence.observation : operatorMergedObservation(expected, now);
  if (!observation) return failure("missing_pull_request_evidence", "the cohort's reported pull request URL is not a canonical GitHub URL");

  const previous = await dependencies.reconciliations.find(expected.stage_instance_id, expected.unit_id);
  const reconciled = reconcileCohortPullRequest({ expected, observation, previous, reconciled_at: now });
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
