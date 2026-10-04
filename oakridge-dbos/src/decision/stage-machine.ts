import { V15_PAYLOAD_CONTRACTS } from "../domain/v15-action-inputs";
import { err, ok, type Result } from "../domain/primitives";
import { validatePlanCohorts, validateBriefCollection } from "./schedule-cohorts";
import type { PlanBody } from "../domain/dev-flow-artifacts";
import { finalPullRequestMatchesPreparedRepository } from "../domain/cohort-pull-request";
import type { ArtifactRef, CohortDecisionError, ImplementationCohortDefinition, ImplementationCohortRecord,
  OperatorRequest, ResolvedWorkerAction, SelectedDecision, VerifiedPrObservation, V15DecisionTree,
  V15Fact, V15WorkerAction, V15Change, BuildReviewTarget, AssessmentReviewTarget,
  RepositoryPreparationCohortRecord, SpecAnalysisCohortRecord, PlanningCohortRecord,
  BriefWritingCohortRecord, FinalIntegrationCohortRecord, FinalPrReviewTarget,
  V15OperatorRequest, V15WorkerKey, RepositoryPreparationInputs, ProvisionRetryInput,
  SpecAnalysisInputs, SpecRevisionInput, SpecWorkInput, PlanWorkInput, PlanningInputs,
  PlanRevisionInput, BriefWritingInputs, BriefRevisionInput, BriefRetryInput,
  ArtifactRetryInput, FinalIntegrationInputs, FinalRetryInput } from "../domain/dev-flow-v15";

export interface CohortEvaluationInput {
  readonly definition: ImplementationCohortDefinition;
  readonly snapshot: ImplementationCohortRecord;
  readonly request: OperatorRequest | null;
  readonly pr: VerifiedPrObservation | null;
  /** Resolved against the artifact ledger before evaluation. */
  readonly available_artifacts: readonly ArtifactRef[];
}

const sameRef = (left: ArtifactRef | null, right: ArtifactRef | null): boolean =>
  left !== null && right !== null && left.id === right.id && left.version === right.version;
const currentBuild = (snapshot: ImplementationCohortRecord) => {
  const { build_result, pr_summary } = snapshot.build.outputs;
  return build_result && pr_summary
    ? { build_result: { id: build_result.id, version: build_result.version },
        pr_summary: { id: pr_summary.id, version: pr_summary.version } } : null;
};
const acceptedBuildForAction = (snapshot: ImplementationCohortRecord, request: OperatorRequest | null) => {
  if (snapshot.accepted_build) return snapshot.accepted_build;
  if (request?.kind !== "accept_build" || !sameBuildTarget(snapshot, request.target)) return null;
  const pr_url = snapshot.build.outputs.pr_summary?.body.pr_url;
  return pr_url ? { outputs: request.target.outputs, head_sha: request.target.head_sha, pr_url } : null;
};
const sameBuildTarget = (snapshot: ImplementationCohortRecord, target: BuildReviewTarget): boolean => {
  const outputs = currentBuild(snapshot);
  return outputs !== null && sameRef(outputs.build_result, target.outputs.build_result)
    && sameRef(outputs.pr_summary, target.outputs.pr_summary)
    && snapshot.build.response?.head_sha === target.head_sha;
};
const sameAssessmentTarget = (snapshot: ImplementationCohortRecord, target: AssessmentReviewTarget): boolean => {
  const assessment = snapshot.assessment.outputs.assessment;
  const accepted = snapshot.accepted_build;
  return assessment !== null && accepted !== null
    && sameRef({ id: assessment.id, version: assessment.version }, target.assessment)
    && sameRef(accepted.outputs.build_result, target.build.outputs.build_result)
    && sameRef(accepted.outputs.pr_summary, target.build.outputs.pr_summary)
    && accepted.head_sha === target.build.head_sha && accepted.pr_url === target.build.pr_url;
};

export const buildOutputsReady = (snapshot: ImplementationCohortRecord): boolean => {
  const response = snapshot.build.response;
  const outputs = currentBuild(snapshot);
  return response !== null && outputs !== null && response.execution_id === snapshot.build.active_execution_id
    && response.head_sha !== null && sameRef(response.build_result, outputs.build_result)
    && sameRef(response.pr_summary, outputs.pr_summary);
};

export const assessmentResponseReady = (snapshot: ImplementationCohortRecord): boolean => {
  const response = snapshot.assessment.response;
  const output = snapshot.assessment.outputs.assessment;
  return response !== null && output !== null && snapshot.accepted_build !== null
    && response.execution_id === snapshot.assessment.active_execution_id
    && sameRef(response.assessment, { id: output.id, version: output.version })
    && response.build.head_sha === snapshot.accepted_build.head_sha
    && response.build.pr_url === snapshot.accepted_build.pr_url
    && sameRef(response.build.outputs.build_result, snapshot.accepted_build.outputs.build_result)
    && sameRef(response.build.outputs.pr_summary, snapshot.accepted_build.outputs.pr_summary);
};

export const buildExecutionInterrupted = (snapshot: ImplementationCohortRecord): boolean =>
  snapshot.build.interrupted?.execution.execution_id === snapshot.build.active_execution_id;
export const assessmentExecutionInterrupted = (snapshot: ImplementationCohortRecord): boolean =>
  snapshot.assessment.interrupted?.execution.execution_id === snapshot.assessment.active_execution_id;
export const prClosedUnmerged = (snapshot: ImplementationCohortRecord, pr: VerifiedPrObservation | null): boolean =>
  pr?.state === "closed"
    && pr.pr_url === (snapshot.accepted_build?.pr_url ?? snapshot.build.outputs.pr_summary?.body.pr_url)
    && pr.repository_key === snapshot.inputs.repository.refs.repository_key
    && pr.head_branch === snapshot.inputs.repository.canonical_branch
    && pr.base_branch === snapshot.inputs.repository.expected_pr_base;
export const prMergedAtAcceptedHead = (snapshot: ImplementationCohortRecord, pr: VerifiedPrObservation | null): boolean =>
  pr?.state === "merged" && snapshot.accepted_build !== null
    && pr.pr_url === snapshot.accepted_build.pr_url && pr.head_sha === snapshot.accepted_build.head_sha
    && pr.repository_key === snapshot.inputs.repository.refs.repository_key
    && pr.head_branch === snapshot.inputs.repository.canonical_branch
    && pr.base_branch === snapshot.inputs.repository.expected_pr_base;

export type V15FactContext =
  | { readonly stage: "repository_preparation"; readonly cohort: RepositoryPreparationCohortRecord }
  | { readonly stage: "spec_analysis"; readonly cohort: SpecAnalysisCohortRecord }
  | { readonly stage: "planning"; readonly cohort: PlanningCohortRecord }
  | { readonly stage: "brief_writing"; readonly cohort: BriefWritingCohortRecord; readonly accepted_plan?: PlanBody }
  | { readonly stage: "implementation"; readonly cohort: ImplementationCohortRecord; readonly pr: VerifiedPrObservation | null }
  | { readonly stage: "final_integration"; readonly cohort: FinalIntegrationCohortRecord;
      readonly pr: VerifiedPrObservation | null; readonly reviewed_target: FinalPrReviewTarget | null };

const reviewOutputReady = (active: string | null, response: { readonly execution_id: string;
  readonly current: ArtifactRef | null } | null, output: { readonly id: string; readonly version: number } | null): boolean =>
  response !== null && output !== null && response.execution_id === active
    && sameRef(response.current, output as ArtifactRef);
const reviewExecutionInterrupted = (active: string | null,
  interruption: { readonly execution: { readonly execution_id: string } } | null): boolean =>
  interruption?.execution.execution_id === active;

export const provisionOutputsReady = (cohort: RepositoryPreparationCohortRecord): boolean => {
  const response = cohort.provision.response;
  const output = cohort.provision.outputs.repository_refs;
  return response?.execution_id === cohort.provision.active_execution_id
    && response?.outcome.kind === "succeeded" && output !== null
    && sameRef(response.outcome.output, { id: output.id, version: output.version });
};
export const provisionFailed = (cohort: RepositoryPreparationCohortRecord): boolean =>
  cohort.provision.response?.execution_id === cohort.provision.active_execution_id
  && cohort.provision.response?.outcome.kind === "failed";
export const provisionExecutionInterrupted = (cohort: RepositoryPreparationCohortRecord): boolean =>
  reviewExecutionInterrupted(cohort.provision.active_execution_id, cohort.provision.interrupted);

export const specOutputsReady = (cohort: SpecAnalysisCohortRecord): boolean =>
  reviewOutputReady(cohort.spec.active_execution_id, cohort.spec.response, cohort.spec.outputs.spec_analysis);
export const specExecutionInterrupted = (cohort: SpecAnalysisCohortRecord): boolean =>
  reviewExecutionInterrupted(cohort.spec.active_execution_id, cohort.spec.interrupted);
export const planOutputsReady = (cohort: PlanningCohortRecord): boolean => {
  if (!reviewOutputReady(cohort.plan.active_execution_id, cohort.plan.response, cohort.plan.outputs.plan)) return false;
  const plan = cohort.plan.outputs.plan;
  return plan !== null && validatePlanCohorts(plan.body,
    new Set(cohort.inputs.repositories.map((repository) => repository.repository_key))).ok;
};
export const planExecutionInterrupted = (cohort: PlanningCohortRecord): boolean =>
  reviewExecutionInterrupted(cohort.plan.active_execution_id, cohort.plan.interrupted);
export const briefOutputsReady = (cohort: BriefWritingCohortRecord, plan?: PlanBody): boolean => {
  const response = cohort.brief.response;
  if (response?.execution_id !== cohort.brief.active_execution_id || !response?.current) return false;
  const stored = cohort.brief.outputs.briefs;
  return plan !== undefined && validateBriefCollection(plan.cohorts, stored.map((member) => member.artifact.body)).ok
    && stored.every((member) => member.artifact.provenance.execution_id === cohort.brief.active_execution_id)
    && new Set(response.current.members.map((member) => member.cohort_key)).size === response.current.members.length
    && response.current.members.length === stored.length
    && response.current.members.every((member) => stored.some((candidate) =>
      candidate.cohort_key === member.cohort_key
      && sameRef(member.ref, { id: candidate.artifact.id, version: candidate.artifact.version })));
};
export const briefExecutionInterrupted = (cohort: BriefWritingCohortRecord): boolean =>
  reviewExecutionInterrupted(cohort.brief.active_execution_id, cohort.brief.interrupted);
export const finalOutputsReady = (cohort: FinalIntegrationCohortRecord, pr: VerifiedPrObservation | null): boolean =>
  reviewOutputReady(cohort.final_integration.active_execution_id, cohort.final_integration.response,
    cohort.final_integration.outputs.pr_summary)
  && finalPullRequestMatchesPreparedRepository(cohort, pr)
  && pr?.pr_url === cohort.final_integration.outputs.pr_summary?.body.pr_url
  && Boolean(cohort.final_integration.response?.head_sha)
  && pr?.head_sha === cohort.final_integration.response?.head_sha;
export const finalExecutionInterrupted = (cohort: FinalIntegrationCohortRecord): boolean =>
  reviewExecutionInterrupted(cohort.final_integration.active_execution_id, cohort.final_integration.interrupted);
export const finalPrMergedAtReviewedHead = (cohort: FinalIntegrationCohortRecord,
  pr: VerifiedPrObservation | null, target: FinalPrReviewTarget | null): boolean =>
  finalPullRequestMatchesPreparedRepository(cohort, pr) && pr?.state === "merged" && target !== null
  && sameRef(target.pr_summary, currentRef(cohort.final_integration.outputs.pr_summary))
  && pr.pr_url === target.pr_url && pr.head_sha === target.head_sha
  && target.head_sha === cohort.final_integration.response?.head_sha;
export const finalPrClosedUnmerged = (cohort: FinalIntegrationCohortRecord,
  pr: VerifiedPrObservation | null, target: FinalPrReviewTarget | null): boolean =>
  finalPullRequestMatchesPreparedRepository(cohort, pr) && pr?.state === "closed" && target !== null
  && sameRef(target.pr_summary, currentRef(cohort.final_integration.outputs.pr_summary))
  && pr.pr_url === target.pr_url && pr.head_sha === target.head_sha
  && target.head_sha === cohort.final_integration.response?.head_sha;

/** Every authored v15 fact is a fixed transform over a typed snapshot. */
export const evaluateV15Fact = (context: V15FactContext, fact: V15Fact): boolean | null => {
  switch (context.stage) {
    case "repository_preparation":
      switch (fact) {
        case "provision_outputs_ready": return provisionOutputsReady(context.cohort);
        case "provision_failed": return provisionFailed(context.cohort);
        case "provision_execution_interrupted": return provisionExecutionInterrupted(context.cohort);
        default: return null;
      }
    case "spec_analysis":
      return fact === "spec_outputs_ready" ? specOutputsReady(context.cohort)
        : fact === "spec_execution_interrupted" ? specExecutionInterrupted(context.cohort) : null;
    case "planning":
      return fact === "plan_outputs_ready" ? planOutputsReady(context.cohort)
        : fact === "plan_execution_interrupted" ? planExecutionInterrupted(context.cohort) : null;
    case "brief_writing":
      return fact === "brief_outputs_ready" ? briefOutputsReady(context.cohort, context.accepted_plan)
        : fact === "brief_execution_interrupted" ? briefExecutionInterrupted(context.cohort) : null;
    case "implementation": return implementationFact(fact, context.cohort, context.pr);
    case "final_integration":
      switch (fact) {
        case "final_outputs_ready": return finalOutputsReady(context.cohort, context.pr);
        case "final_execution_interrupted": return finalExecutionInterrupted(context.cohort);
        case "final_pr_merged_at_reviewed_head": return finalPrMergedAtReviewedHead(context.cohort, context.pr, context.reviewed_target);
        case "final_pr_closed_unmerged": return finalPrClosedUnmerged(context.cohort, context.pr, context.reviewed_target);
        default: return null;
      }
  }
};

/** Publication completeness is a domain fact, independent of session exit. */
export const workerResponseReady = (context: V15FactContext, worker: V15WorkerKey): boolean => {
  switch (context.stage) {
    case "repository_preparation": return provisionOutputsReady(context.cohort);
    case "spec_analysis": return specOutputsReady(context.cohort);
    case "planning": return planOutputsReady(context.cohort);
    case "brief_writing": return briefOutputsReady(context.cohort, context.accepted_plan);
    case "implementation": return worker === "build" ? buildOutputsReady(context.cohort)
      : worker === "assessment" && assessmentResponseReady(context.cohort);
    case "final_integration": return reviewOutputReady(context.cohort.final_integration.active_execution_id,
      context.cohort.final_integration.response, context.cohort.final_integration.outputs.pr_summary);
  }
};

const implementationFact = (fact: V15Fact, snapshot: ImplementationCohortRecord, pr: VerifiedPrObservation | null): boolean | null => {
  switch (fact) {
    case "build_outputs_ready": return buildOutputsReady(snapshot);
    case "assessment_response_ready": return assessmentResponseReady(snapshot);
    case "build_execution_interrupted": return buildExecutionInterrupted(snapshot);
    case "assessment_execution_interrupted": return assessmentExecutionInterrupted(snapshot);
    case "pr_closed_unmerged": return prClosedUnmerged(snapshot, pr);
    case "pr_merged_at_accepted_head": return prMergedAtAcceptedHead(snapshot, pr);
    default: return null;
  }
};

const reviewIsCurrent = (snapshot: ImplementationCohortRecord, request: OperatorRequest): boolean => {
  switch (request.kind) {
    case "accept_build": case "replace_pr": return sameBuildTarget(snapshot, request.target);
    case "request_build_changes": return sameBuildTarget(snapshot, request.feedback.target);
    case "accept_assessment": return sameAssessmentTarget(snapshot, request.target);
    case "discuss_assessment": case "request_implementation_changes":
      return sameAssessmentTarget(snapshot, request.feedback.target);
    default: return true;
  }
};

const invalidCombination = (snapshot: ImplementationCohortRecord): string | null => {
  if (snapshot.build.state === "accepted" && snapshot.accepted_build === null) return "accepted builder has no captured build";
  if (snapshot.accepted_build !== null && snapshot.build.state !== "accepted") return "captured build has no accepted builder";
  if (["working", "awaiting_review", "accepted", "interrupted"].includes(snapshot.assessment.state)
    && snapshot.accepted_build === null) return "assessor has work without an accepted build";
  if (snapshot.state === "awaiting_merge" && snapshot.assessment.state !== "accepted") return "merge wait has no accepted assessment";
  return null;
};

const artifactAvailable = (ref: ArtifactRef, available: readonly ArtifactRef[]): boolean =>
  available.some((candidate) => sameRef(candidate, ref));

const referencedArtifacts = (value: unknown): readonly ArtifactRef[] => {
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(referencedArtifacts);
  if ("id" in value && "version" in value && typeof value.id === "string" && typeof value.version === "number")
    return [value as ArtifactRef];
  return Object.values(value).flatMap(referencedArtifacts);
};

const actionFields = (worker: V15WorkerKey, point: string): readonly string[] | null => {
  const action = V15_PAYLOAD_CONTRACTS.find((contract) => contract.worker === worker)?.actions[point];
  return action ? Object.keys(action.fields) : null;
};

const resolveImplementationAction = (input: CohortEvaluationInput, action: V15WorkerAction):
  Result<ResolvedWorkerAction, string> => {
  const { snapshot, request, definition, pr, available_artifacts } = input;
  if (action.worker !== "build" && action.worker !== "assessment") return err(`worker ${action.worker} is not in implementation`);
  const configured = definition.workers[action.worker].action_points[action.action_point as never] as
    { readonly prompt: string; readonly inputs: Readonly<Record<string, { readonly from: string }>> } | undefined;
  if (!configured?.prompt.trim()) return err(`missing prompt for ${action.worker}.${action.action_point}`);
  const expectedFields = actionFields(action.worker, action.action_point);
  if (!expectedFields || expectedFields.length !== Object.keys(configured.inputs).length
    || expectedFields.some((field) => !(field in configured.inputs)))
    return err(`incomplete input bindings for ${action.worker}.${action.action_point}`);
  const build = currentBuild(snapshot);
  const interruptedBuild = snapshot.build.interrupted;
  const interruptedAssessment = snapshot.assessment.interrupted;
  const sources: Readonly<Record<string, unknown>> = {
    "inputs.brief": snapshot.inputs.brief,
    "inputs.repository": snapshot.inputs.repository.worktree_base_sha === null ? null : snapshot.inputs.repository,
    "build.outputs": build,
    "request.feedback": request && "feedback" in request ? request.feedback : null,
    "build.interrupted.work": interruptedBuild?.work ?? null,
    "build.interrupted.execution": interruptedBuild?.execution ?? null,
    "build.interrupted.build_result": interruptedBuild?.build_result ?? null,
    "build.interrupted.pr_summary": interruptedBuild?.pr_summary ?? null,
    "observations.pr": pr,
    "accepted_build": acceptedBuildForAction(snapshot, request),
    "assessment.work.input.accepted_build": snapshot.assessment.work?.input.accepted_build ?? null,
    "assessment.outputs.assessment": snapshot.assessment.outputs.assessment
      ? { id: snapshot.assessment.outputs.assessment.id, version: snapshot.assessment.outputs.assessment.version } : null,
    "assessment.interrupted.work": interruptedAssessment?.work ?? null,
    "assessment.interrupted.execution": interruptedAssessment?.execution ?? null,
    "assessment.interrupted.assessment": interruptedAssessment?.assessment ?? null,
  };
  const resolved: Record<string, unknown> = {};
  for (const [field, binding] of Object.entries(configured.inputs)) {
    const value = sources[binding.from];
    if (value === undefined || value === null && !binding.from.includes("interrupted."))
      return err(`unavailable input ${binding.from} for ${action.worker}.${action.action_point}.${field}`);
    resolved[field] = value;
  }
  const referenced = referencedArtifacts(resolved);
  for (const ref of referenced) if (!artifactAvailable(ref, available_artifacts)) return err(`artifact ${ref.id}@${ref.version} is unavailable`);
  if (action.worker === "build") return ok({ worker: "build", action: { action_point: action.action_point,
    input: resolved } as ResolvedWorkerAction & never });
  return ok({ worker: "assessment", action: { action_point: action.action_point,
    input: resolved } as ResolvedWorkerAction & never });
};

/** Implementation callers use the same evaluator and tree walk as every stage. */
export const evaluateCohort = (input: CohortEvaluationInput): Result<SelectedDecision, CohortDecisionError> =>
  evaluateV15Cohort({ definition: input.definition, context: { stage: "implementation", cohort: input.snapshot, pr: input.pr },
    request: input.request, available_artifacts: input.available_artifacts }) as Result<SelectedDecision, CohortDecisionError>;

export type V15ResolvedAction = ResolvedWorkerAction
  | { readonly worker: "provision"; readonly action: { readonly action_point: "initial"; readonly input: RepositoryPreparationInputs }
    | { readonly action_point: "retry"; readonly input: ProvisionRetryInput } }
  | { readonly worker: "spec"; readonly action: { readonly action_point: "initial"; readonly input: SpecAnalysisInputs }
    | { readonly action_point: "revise"; readonly input: SpecRevisionInput }
    | { readonly action_point: "retry"; readonly input: ArtifactRetryInput<SpecWorkInput> } }
  | { readonly worker: "plan"; readonly action: { readonly action_point: "initial"; readonly input: PlanningInputs }
    | { readonly action_point: "revise"; readonly input: PlanRevisionInput }
    | { readonly action_point: "retry"; readonly input: ArtifactRetryInput<PlanWorkInput> } }
  | { readonly worker: "brief"; readonly action: { readonly action_point: "initial"; readonly input: BriefWritingInputs }
    | { readonly action_point: "revise"; readonly input: BriefRevisionInput }
    | { readonly action_point: "retry"; readonly input: BriefRetryInput } }
  | { readonly worker: "final_integration"; readonly action: { readonly action_point: "initial"; readonly input: FinalIntegrationInputs }
    | { readonly action_point: "retry"; readonly input: FinalRetryInput } };

export type V15SelectedDecision =
  | { readonly kind: "wait"; readonly reason: string }
  | { readonly kind: "apply"; readonly expected_version: number;
      readonly changes: readonly V15Change[]; readonly actions: readonly V15ResolvedAction[] };

interface V15ConfiguredAction {
  readonly prompt?: string;
  readonly operation?: "provision_repository_refs";
  readonly inputs: Readonly<Record<string, { readonly from: string }>>;
}
export interface V15CompiledCohortDefinition {
  readonly decision_tree: V15DecisionTree;
  readonly workers: Readonly<Partial<Record<V15WorkerKey, {
    readonly action_points: Readonly<Record<string, V15ConfiguredAction>>;
  }>>>;
}
export interface V15EvaluationInput {
  readonly definition: V15CompiledCohortDefinition;
  readonly context: V15FactContext;
  readonly request: V15OperatorRequest | null;
  readonly available_artifacts: readonly ArtifactRef[];
}

const currentRef = (artifact: { readonly id: string; readonly version: number } | null): ArtifactRef | null =>
  artifact ? { id: artifact.id as ArtifactRef["id"], version: artifact.version } : null;

const genericWorker = (context: V15FactContext): { readonly key: V15WorkerKey; readonly state: string } => {
  switch (context.stage) {
    case "repository_preparation": return { key: "provision", state: context.cohort.provision.state };
    case "spec_analysis": return { key: "spec", state: context.cohort.spec.state };
    case "planning": return { key: "plan", state: context.cohort.plan.state };
    case "brief_writing": return { key: "brief", state: context.cohort.brief.state };
    case "final_integration": return { key: "final_integration", state: context.cohort.final_integration.state };
    case "implementation": return { key: "build", state: context.cohort.build.state };
  }
};

const genericSources = (context: V15FactContext, request: V15OperatorRequest | null): Readonly<Record<string, unknown>> => {
  const feedback = request && "feedback" in request ? request.feedback : null;
  switch (context.stage) {
    case "repository_preparation": return {
      "inputs": context.cohort.inputs, "inputs.repository": context.cohort.inputs.repository,
      "inputs.base_branch": context.cohort.inputs.base_branch,
      "provision.interrupted.execution": context.cohort.provision.interrupted?.execution ?? null,
    };
    case "spec_analysis": return {
      "inputs": context.cohort.inputs, "inputs.brief_notes": context.cohort.inputs.brief_notes,
      "inputs.repositories": context.cohort.inputs.repositories,
      "spec.outputs.spec_analysis": currentRef(context.cohort.spec.outputs.spec_analysis),
      "spec.interrupted.work": context.cohort.spec.interrupted?.work ?? null,
      "spec.interrupted.execution": context.cohort.spec.interrupted?.execution ?? null,
      "spec.interrupted.current": context.cohort.spec.interrupted?.current ?? null,
      "request.feedback": feedback,
    };
    case "planning": return {
      "inputs": context.cohort.inputs, "inputs.spec_analysis": context.cohort.inputs.spec_analysis,
      "inputs.repositories": context.cohort.inputs.repositories,
      "plan.outputs.plan": currentRef(context.cohort.plan.outputs.plan),
      "plan.interrupted.work": context.cohort.plan.interrupted?.work ?? null,
      "plan.interrupted.execution": context.cohort.plan.interrupted?.execution ?? null,
      "plan.interrupted.current": context.cohort.plan.interrupted?.current ?? null,
      "request.feedback": feedback,
    };
    case "brief_writing": return {
      "inputs": context.cohort.inputs, "inputs.plan": context.cohort.inputs.plan,
      "inputs.repositories": context.cohort.inputs.repositories,
      "brief.outputs.briefs": { members: context.cohort.brief.outputs.briefs.map((member) => ({
        cohort_key: member.cohort_key, ref: currentRef(member.artifact),
      })) },
      "brief.interrupted.work": context.cohort.brief.interrupted?.work ?? null,
      "brief.interrupted.execution": context.cohort.brief.interrupted?.execution ?? null,
      "brief.interrupted.current": context.cohort.brief.interrupted?.current ?? null,
      "request.feedback": feedback,
    };
    case "final_integration": return {
      "inputs": context.cohort.inputs, "inputs.repository": context.cohort.inputs.repository,
      "inputs.completed_cohorts": context.cohort.inputs.completed_cohorts,
      "final_integration.interrupted.execution": context.cohort.final_integration.interrupted?.execution ?? null,
      "final_integration.interrupted.current": context.cohort.final_integration.interrupted?.current ?? null,
    };
    case "implementation": return {};
  }
};

const genericReviewIsCurrent = (context: V15FactContext, request: V15OperatorRequest): boolean => {
  switch (context.stage) {
    case "spec_analysis":
      return request.kind === "accept_analysis" ? sameRef(request.target, currentRef(context.cohort.spec.outputs.spec_analysis))
        : request.kind === "revise_analysis" ? sameRef(request.feedback.target, currentRef(context.cohort.spec.outputs.spec_analysis)) : true;
    case "planning":
      return request.kind === "accept_plan" ? sameRef(request.target, currentRef(context.cohort.plan.outputs.plan))
        : request.kind === "revise_plan" ? sameRef(request.feedback.target, currentRef(context.cohort.plan.outputs.plan)) : true;
    case "brief_writing": {
      if (request.kind !== "accept_briefs" && request.kind !== "revise_briefs") return true;
      const target = request.kind === "accept_briefs" ? request.target : request.feedback.target;
      const stored = context.cohort.brief.outputs.briefs;
      return new Set(target.members.map((member) => member.cohort_key)).size === target.members.length
        && target.members.length === stored.length && target.members.every((member) => stored.some((candidate) =>
        candidate.cohort_key === member.cohort_key && sameRef(member.ref, currentRef(candidate.artifact))));
    }
    case "final_integration":
      return request.kind === "confirm_merged" || request.kind === "closed_without_merge"
        ? sameRef(request.target.pr_summary, currentRef(context.cohort.final_integration.outputs.pr_summary))
          && request.target.pr_url === context.cohort.final_integration.outputs.pr_summary?.body.pr_url : true;
    default: return true;
  }
};

const resolveGenericAction = (input: V15EvaluationInput, action: V15WorkerAction): Result<V15ResolvedAction, string> => {
  const owner = genericWorker(input.context);
  if (action.worker !== owner.key) return err(`worker ${action.worker} does not belong to ${input.context.stage}`);
  const configured = input.definition.workers[action.worker]?.action_points[action.action_point];
  if (!configured || !configured.prompt?.trim() && configured.operation !== "provision_repository_refs")
    return err(`missing prompt or operation for ${action.worker}.${action.action_point}`);
  const required = actionFields(action.worker, action.action_point);
  if (!required || required.length !== Object.keys(configured.inputs).length
    || required.some((field) => !(field in configured.inputs)))
    return err(`incomplete input bindings for ${action.worker}.${action.action_point}`);
  const sources = genericSources(input.context, input.request);
  const resolved: Record<string, unknown> = {};
  for (const [field, binding] of Object.entries(configured.inputs)) {
    const value = sources[binding.from];
    if (value === undefined || value === null && !binding.from.includes("interrupted."))
      return err(`unavailable input ${binding.from} for ${action.worker}.${action.action_point}.${field}`);
    resolved[field] = value;
  }
  for (const ref of referencedArtifacts(resolved)) if (!artifactAvailable(ref, input.available_artifacts))
    return err(`artifact ${ref.id}@${ref.version} is unavailable`);
  return ok({ worker: action.worker, action: { action_point: action.action_point, input: resolved } } as unknown as V15ResolvedAction);
};

/** The exact review target is checked both at selection and under the commit lock. */
export const isCohortReviewCurrent = (context: V15FactContext, request: V15OperatorRequest): boolean =>
  context.stage === "implementation" ? reviewIsCurrent(context.cohort, request as OperatorRequest)
    : genericReviewIsCurrent(context, request);

/** One tree walk evaluates every v15 stage. */
export const evaluateV15Cohort = (input: V15EvaluationInput): Result<V15SelectedDecision, CohortDecisionError> => {
  const { context, request } = input;
  const fail = (kind: CohortDecisionError["kind"], detail: string): Result<V15SelectedDecision, CohortDecisionError> =>
    err({ kind, operation: "evaluate_cohort", cohort_id: context.cohort.id, detail });
  if (context.stage === "implementation") {
    const contradiction = invalidCombination(context.cohort);
    if (contradiction) return fail("invalid_state", contradiction);
  }
  if (request && !isCohortReviewCurrent(context, request)) return fail("stale_review", `${request.kind} target is not current`);
  let node = input.definition.decision_tree;
  for (let depth = 0; depth < 256; depth++) {
    switch (node.kind) {
      case "match_cohort": node = node.cases[context.cohort.state] ?? node.otherwise; break;
      case "match_worker": {
        const state = context.stage === "implementation"
          ? node.worker === "build" || node.worker === "assessment" ? context.cohort[node.worker].state : null
          : node.worker === genericWorker(context).key ? genericWorker(context).state : null;
        if (state === null) return fail("invalid_definition", `unknown worker ${node.worker}`);
        node = node.cases[state as import("../domain/dev-flow-v15").WorkerState] ?? node.otherwise;
        break;
      }
      case "match_request": node = node.cases[request?.kind ?? "none"] ?? node.otherwise; break;
      case "if": {
        const fact = evaluateV15Fact(context, node.fact);
        if (fact === null) return fail("invalid_definition", `unsupported fact ${node.fact}`);
        node = fact ? node.then : node.else;
        break;
      }
      case "wait": return ok({ kind: "wait", reason: node.reason });
      case "reject": return fail(request ? "invalid_request" : "invalid_state", node.reason);
      case "apply": {
        const changes = node.changes;
        const states = changes.filter((change) => change.kind === "set_cohort_state");
        const workerStates = changes.filter((change) => change.kind === "set_worker_state");
        if (new Set(states.map((change) => change.state)).size > 1
          || workerStates.some((change) => workerStates.some((other) => change.worker === other.worker && change.state !== other.state))
          || changes.some((change) => "worker" in change && (context.stage === "implementation"
            ? change.worker !== "build" && change.worker !== "assessment" : change.worker !== genericWorker(context).key)))
          return fail("invalid_definition", "contradictory or mismatched state changes");
        if (changes.some((change) => change.kind === "capture_accepted_build")
          && changes.some((change) => change.kind === "clear_accepted_build"))
          return fail("invalid_definition", "captured build is both set and cleared");
        if (changes.some((change) => change.kind === "accept_outputs"
          && changes.some((other) => other.kind === "clear_acceptance" && other.worker === change.worker)))
          return fail("invalid_definition", "acceptance is both set and cleared");
        const actions: V15ResolvedAction[] = [];
        for (const action of node.actions) {
          if (actions.some((candidate) => candidate.worker === action.worker))
            return fail("invalid_definition", `multiple actions for worker ${action.worker}`);
          if (!workerStates.some((change) => change.worker === action.worker && change.state === "working"))
            return fail("invalid_definition", `action ${action.worker}.${action.action_point} lacks working state`);
          const resolved = context.stage === "implementation"
            ? resolveImplementationAction({ definition: input.definition as ImplementationCohortDefinition,
              snapshot: context.cohort, request: request as OperatorRequest | null,
              pr: context.pr, available_artifacts: input.available_artifacts }, action)
            : resolveGenericAction(input, action);
          if (!resolved.ok) return fail("unavailable_input", resolved.error);
          actions.push(resolved.value);
        }
        return ok({ kind: "apply", expected_version: context.cohort.version, changes, actions });
      }
    }
  }
  return fail("invalid_definition", "decision tree exceeded maximum depth");
};
