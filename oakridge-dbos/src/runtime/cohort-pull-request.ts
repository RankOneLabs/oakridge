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
import type { EpicRepositoryBinding } from "../domain/epic";
import { err, ok, type JsonValue, type Result, type StageInstanceId, type UnitId } from "../domain/primitives";
import type { PullRequestObservation } from "../domain/pull-request";
import { handoffWorkflowId } from "../domain/workflow-ids";
import type { HandoffWorkflowState } from "../http/gate-resume";
import type { HandoffCommand } from "../workflows/handoff";
import type { ArtifactRevisionRepository, CohortPullRequestRepository, EpicWorkflowProfileRepository, ExecutionArtifactContext, ExecutionArtifactContextRepository, WorkflowRunRepository } from "../storage/repositories";

/** The artifact type whose body reports the pull request a cohort opened. */
const PR_SUMMARY_ARTIFACT_TYPE = "dev.pr_summary";
const GITHUB_REVIEW_WAIT = "github_review";

export interface CohortPullRequestDependencies {
  readonly runs: WorkflowRunRepository;
  readonly epic_profiles: EpicWorkflowProfileRepository;
  readonly contexts: ExecutionArtifactContextRepository;
  readonly artifacts: ArtifactRevisionRepository;
  readonly reconciliations: CohortPullRequestRepository;
  readonly get_handoff_state: (workflow_id: string) => Promise<HandoffWorkflowState | null>;
  readonly send_handoff_command: (workflow_id: string, command: HandoffCommand, idempotency_key: string) => Promise<void>;
  readonly now: () => string;
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
 * The branch a cohort's pull request should target, from whichever binding the
 * run has. An Epic profile is authoritative; a run launched without one still
 * declares its repositories in its context. Neither is guaranteed, and an
 * expectation the run never stated is not one the evidence can fail.
 */
const selectExpectedBaseBranch = (repositoryKey: string, binding: EpicRepositoryBinding | null, runContext: JsonValue): string | null => {
  if (binding) return binding.epic_branch;
  if (!isObject(runContext)) return null;
  const repositories = runContext.repositories;
  if (!Array.isArray(repositories)) return null;
  const declared = repositories.find((candidate) => isObject(candidate) && candidate.key === repositoryKey);
  return declared && isObject(declared) && typeof declared.epic_branch === "string" ? declared.epic_branch : null;
};

interface CohortHandoff {
  readonly context: ExecutionArtifactContext;
  readonly expected: ExpectedCohortPullRequest;
  readonly handoff_workflow_id: string;
}

/** Everything the run already knows about this cohort's pull request. */
const loadCohortHandoff = async (
  dependencies: CohortPullRequestDependencies,
  stageInstanceId: StageInstanceId,
  unitId: UnitId,
): Promise<Result<CohortHandoff, CohortPullRequestError>> => {
  const context = await dependencies.contexts.find_for_emit(stageInstanceId, unitId);
  if (!context) return failure("cohort_not_found", `no execution for stage '${stageInstanceId}' unit '${unitId}'`);

  const handoffOutput = context.outputs.find((output) => output.release.kind === "handoff");
  if (!handoffOutput || handoffOutput.release.kind !== "handoff") return failure("not_a_pull_request_cohort", "this unit's stage declares no handoff output");
  if (handoffOutput.release.external_wait_kind !== GITHUB_REVIEW_WAIT) {
    return failure("not_a_pull_request_cohort", `this unit's handoff waits on '${handoffOutput.release.external_wait_kind}', not '${GITHUB_REVIEW_WAIT}'`);
  }
  const coordinate = { stage_instance_id: context.stage_instance_id, execution_id: context.execution_id, unit_id: context.unit_id } as const;
  const handoffArtifact = await dependencies.artifacts.find_current({ ...coordinate, output_name: handoffOutput.name });
  if (!handoffArtifact) return failure("missing_pull_request_evidence", `unit '${unitId}' has emitted no current '${handoffOutput.name}'`);

  // The summary is looked up by tip rather than by `find_current`, because it
  // has almost certainly been released: it is an immediate output, so the
  // moment the build emits it the run marks it released and its lifecycle stops
  // being `current`. A superseded or withdrawn revision is still refused.
  const summaryOutput = context.outputs.find((output) => output.artifact_type === PR_SUMMARY_ARTIFACT_TYPE);
  const summaryTip = summaryOutput ? await dependencies.artifacts.find_tip({ ...coordinate, output_name: summaryOutput.name }) : null;
  const summaryArtifact = summaryTip && (summaryTip.lifecycle.kind === "current" || summaryTip.lifecycle.kind === "released") ? summaryTip : null;
  if (!summaryArtifact) return failure("missing_pull_request_evidence", `unit '${unitId}' has emitted no live '${PR_SUMMARY_ARTIFACT_TYPE}' to reconcile against`);
  const summary = summaryArtifact.body as unknown as PrSummaryBody;
  const url = readString(summaryArtifact.body, "pr_url");
  const headBranch = readString(summaryArtifact.body, "branch");
  if (!url || !headBranch) return failure("missing_pull_request_evidence", `unit '${unitId}' reported no pull request URL and branch: ${JSON.stringify(summary)}`);

  // The repository key rides on the build result, which is the artifact that
  // names what was built. Falling back to the unit id keeps the durable record
  // addressable for a definition that does not carry one.
  const repositoryKey = readString(handoffArtifact.body, "repository_key" satisfies keyof BuildResultBody) ?? String(unitId);
  const run = await dependencies.runs.find_by_id(context.run_id);
  const profile = await dependencies.epic_profiles.find_by_run_id(context.run_id);
  const binding = profile?.repositories.find((candidate) => candidate.repository_key === repositoryKey) ?? null;

  return ok({
    context,
    handoff_workflow_id: handoffWorkflowId(context.execution_workflow_id, handoffArtifact.id),
    expected: {
      run_id: context.run_id, stage_instance_id: context.stage_instance_id, unit_id: context.unit_id,
      repository_key: repositoryKey, url, head_branch: headBranch,
      base_branch: selectExpectedBaseBranch(repositoryKey, binding, run?.context ?? null),
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
  const { expected, handoff_workflow_id: handoffWorkflow } = loaded.value;

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

  const state = await dependencies.get_handoff_state(handoffWorkflow);
  if (state?.status !== "awaiting_external") {
    // Merged, but there is no wait open to close — the assessor has not
    // approved yet, or something already closed it. Recorded either way; the
    // next observation completes it once the wait exists.
    await dependencies.reconciliations.upsert(reconciled.reconciliation);
    return ok({ resolution: { kind: "merged_not_awaiting", handoff_status: state?.status ?? null }, reconciliation: reconciled.reconciliation });
  }

  const idempotencyKey = evidence.kind === "operator_confirmation"
    ? evidence.idempotency_key
    : `github_review:${expected.stage_instance_id}:${expected.unit_id}:${observation.url}`;
  await dependencies.send_handoff_command(handoffWorkflow,
    { kind: "external_completed", external_kind: GITHUB_REVIEW_WAIT, correlation_id: observation.url }, idempotencyKey);
  const completed = withCompletion(reconciled.reconciliation, now);
  await dependencies.reconciliations.upsert(completed);
  return ok({ resolution: { kind: "completed" }, reconciliation: completed });
};
