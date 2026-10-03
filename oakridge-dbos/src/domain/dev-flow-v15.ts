/** V15 application contract. This module is the future home of the cohort evaluator. */
import type { ArtifactId, CohortId, CohortKey, CommitSha, ExecutionId, RepositoryKey, RequestId, SessionId, StageInstanceId, WorkflowRunId } from "./primitives";
import type { ArtifactRecord } from "./artifacts";
import type { AssessmentBody, BuildBriefBody, BuildResultBody, PlanBody, PrSummaryBody, SpecAnalysisBody } from "./dev-flow-artifacts";

export type StageKey = "repository_preparation" | "spec_analysis" | "planning" | "brief_writing" | "implementation" | "final_integration";
export type StageState = "pending" | "working" | "complete" | "failed" | "cancelled";
export type CohortState = "pending" | "working" | "awaiting_merge" | "complete" | "failed" | "cancelled";
export type WorkerState = "pending" | "working" | "awaiting_review" | "interrupted" | "accepted" | "failed" | "cancelled";
export type SessionState = "running" | "finished" | "interrupted" | "cancelled";
export type AcceptanceMetadata = "unreviewed" | "accepted" | "changes_requested";
export type RevisionPolicy = "update" | "replace";
export interface ArtifactRef { readonly id: ArtifactId; readonly version: number }
/** The sole mapping between v15 artifact references and stored revisions. */
export const artifactRefFromRevision = (artifact: Pick<ArtifactRecord, "chain_id" | "revision">): ArtifactRef => ({ id: artifact.chain_id, version: artifact.revision });
export interface RepositoryRefsBody { readonly repository_key: RepositoryKey; readonly repository_path: string; readonly integration_branch: string; readonly base_branch: string; readonly base_head_sha: CommitSha }
export interface ImplementationRepository { readonly refs: RepositoryRefsBody; readonly worktree_path: string; readonly worktree_base_sha: CommitSha | null; readonly canonical_branch: string; readonly expected_pr_base: string }
export interface PreparedImplementationRepository extends ImplementationRepository { readonly worktree_base_sha: CommitSha }
export interface BuildOutputRefs { readonly build_result: ArtifactRef; readonly pr_summary: ArtifactRef }
export interface AcceptedBuild { readonly outputs: BuildOutputRefs; readonly pr_url: string; readonly head_sha: CommitSha }
export interface InterruptedExecution { readonly execution_id: ExecutionId; readonly session_id: SessionId | null; readonly detail: string }
export interface AgentSession<ActionPoint extends string> { readonly id: SessionId; readonly execution_id: ExecutionId; readonly action_point: ActionPoint; readonly state: SessionState }
export interface AgentExecutionDefinition { readonly settings: { readonly from: "run.planner" | "run.builder" }; readonly pre_authorized_tools: readonly string[]; readonly required_tools: readonly string[]; readonly yolo: boolean }
export interface OutputDeclaration<Type extends string> { readonly type: Type; readonly revision: RevisionPolicy; readonly collection_key?: "cohort_id" }
export interface ActionDefinition { readonly prompt?: string; readonly operation?: "provision_repository_refs"; readonly inputs: Readonly<Record<string, { readonly from: V15BindingSource }>> }
export interface WorkerDefinition { readonly execution?: AgentExecutionDefinition; readonly outputs: Readonly<Record<string, OutputDeclaration<string>>>; readonly action_points: Readonly<Record<string, ActionDefinition>> }
export interface CohortDefinition<Workers extends Readonly<Record<string, WorkerDefinition>> = Readonly<Record<string, WorkerDefinition>>> { readonly workers: Workers; readonly decision_tree: V15DecisionTree }
export type RepositoryPreparationCohortDefinition = CohortDefinition<{ readonly provision: WorkerDefinition }>;
export type SpecAnalysisCohortDefinition = CohortDefinition<{ readonly spec: WorkerDefinition }>;
export type PlanningCohortDefinition = CohortDefinition<{ readonly plan: WorkerDefinition }>;
export type BriefWritingCohortDefinition = CohortDefinition<{ readonly brief: WorkerDefinition }>;
export type ImplementationCohortDefinition = CohortDefinition<{ readonly build: WorkerDefinition; readonly assessment: WorkerDefinition }>;
export type FinalIntegrationCohortDefinition = CohortDefinition<{ readonly final_integration: WorkerDefinition }>;
export interface StageDefinition<Cohort extends CohortDefinition> { readonly prerequisites: readonly StageKey[]; readonly max_active_cohorts: number; readonly cohort: Cohort }
export interface WorkflowDefinition { readonly key: "dev_flow_v15"; readonly version: number; readonly stages: {
  readonly repository_preparation: StageDefinition<RepositoryPreparationCohortDefinition>;
  readonly spec_analysis: StageDefinition<SpecAnalysisCohortDefinition>;
  readonly planning: StageDefinition<PlanningCohortDefinition>;
  readonly brief_writing: StageDefinition<BriefWritingCohortDefinition>;
  readonly implementation: StageDefinition<ImplementationCohortDefinition>;
  readonly final_integration: StageDefinition<FinalIntegrationCohortDefinition>;
} }
export interface StageRecord<Cohort> { readonly id: StageInstanceId; readonly key: StageKey; readonly version: number; readonly state: StageState; readonly prerequisites: readonly StageInstanceId[]; readonly cohorts: readonly Cohort[] | null }
export interface ReviewWorkerRecord<Work, Outputs, Current, Point extends string> { readonly state: WorkerState; readonly active_execution_id: ExecutionId | null; readonly work: Work | null; readonly outputs: Outputs; readonly response: { readonly execution_id: ExecutionId; readonly current: Current } | null; readonly interrupted: { readonly work: Work; readonly execution: InterruptedExecution; readonly current: Current } | null; readonly sessions: readonly AgentSession<Point>[] }
export interface ProvisionWorkerRecord { readonly state: WorkerState; readonly active_execution_id: ExecutionId | null; readonly outputs: { readonly repository_refs: ArtifactRef | null }; readonly response: { readonly execution_id: ExecutionId; readonly outcome: "succeeded" | "failed" } | null; readonly interrupted: { readonly execution: InterruptedExecution } | null; readonly executions: readonly { readonly execution_id: ExecutionId; readonly action_point: "initial" | "retry"; readonly state: SessionState }[] }
export interface CohortRecordBase<Inputs> { readonly id: CohortId; readonly key: RepositoryKey | CohortKey | "spec_analysis" | "planning" | "brief_writing"; readonly version: number; readonly state: CohortState; readonly depends_on: readonly CohortId[]; readonly inputs: Inputs }
export interface RepositoryPreparationCohortRecord extends CohortRecordBase<{ readonly repository: RepositoryRefsBody; readonly base_branch: string }> { readonly provision: ProvisionWorkerRecord }
export interface SpecAnalysisCohortRecord extends CohortRecordBase<{ readonly brief_notes: string; readonly repositories: readonly RepositoryRefsBody[] }> { readonly spec: ReviewWorkerRecord<unknown, { readonly spec_analysis: ArtifactRef | null }, ArtifactRef | null, "initial" | "revise" | "retry"> }
export interface PlanningCohortRecord extends CohortRecordBase<{ readonly spec_analysis: ArtifactRef; readonly repositories: readonly RepositoryRefsBody[] }> { readonly plan: ReviewWorkerRecord<unknown, { readonly plan: ArtifactRef | null }, ArtifactRef | null, "initial" | "revise" | "retry"> }
export interface BriefWritingCohortRecord extends CohortRecordBase<{ readonly plan: ArtifactRef; readonly repositories: readonly RepositoryRefsBody[] }> { readonly brief: ReviewWorkerRecord<unknown, { readonly briefs: readonly ArtifactRef[] }, readonly ArtifactRef[], "initial" | "revise" | "retry"> }
export interface ImplementationCohortRecord extends CohortRecordBase<{ readonly brief: ArtifactRef; readonly repository: ImplementationRepository }> { readonly build: ReviewWorkerRecord<unknown, { readonly build_result: ArtifactRef | null; readonly pr_summary: ArtifactRef | null }, BuildOutputRefs | null, "initial" | "revise" | "retry" | "replace_pr">; readonly assessment: ReviewWorkerRecord<unknown, { readonly assessment: ArtifactRef | null }, ArtifactRef | null, "initial" | "discuss" | "retry">; readonly accepted_build: AcceptedBuild | null }
export interface FinalIntegrationCohortRecord extends CohortRecordBase<{ readonly repository: RepositoryRefsBody; readonly completed_cohorts: readonly ImplementationCohortRecord[] }> { readonly final_integration: ReviewWorkerRecord<unknown, { readonly pr_summary: ArtifactRef | null }, ArtifactRef | null, "initial" | "retry"> }
export interface PublicationIdentity { readonly request_id: RequestId; readonly run_id: WorkflowRunId; readonly stage_id: StageInstanceId; readonly cohort_id: CohortId; readonly execution_id: ExecutionId; readonly session_id: SessionId | null }
export type ArtifactPublication =
  | { readonly output: "repository_refs"; readonly body: RepositoryRefsBody; readonly expected: ArtifactRef | null }
  | { readonly output: "spec_analysis"; readonly body: SpecAnalysisBody; readonly expected: ArtifactRef | null }
  | { readonly output: "plan"; readonly body: PlanBody; readonly expected: ArtifactRef | null }
  | { readonly output: "briefs"; readonly member_key: CohortKey; readonly body: BuildBriefBody; readonly expected: ArtifactRef | null }
  | { readonly output: "build_result"; readonly body: BuildResultBody; readonly head_sha: CommitSha; readonly expected: ArtifactRef | null }
  | { readonly output: "pr_summary"; readonly body: PrSummaryBody; readonly head_sha: CommitSha; readonly expected: ArtifactRef | null }
  | { readonly output: "assessment"; readonly body: AssessmentBody; readonly build: AcceptedBuild; readonly expected: ArtifactRef | null };
export type WorkerPublication = { readonly kind: "artifact"; readonly identity: PublicationIdentity; readonly publication: ArtifactPublication } | { readonly kind: "assessment_unchanged"; readonly identity: PublicationIdentity; readonly assessment: ArtifactRef; readonly build: AcceptedBuild; readonly explanation: string };

export const V15_WORKER_KEYS = ["provision", "spec", "plan", "brief", "build", "assessment", "final_integration"] as const;
export type V15WorkerKey = typeof V15_WORKER_KEYS[number];
export const V15_FACTS = ["build_outputs_ready", "assessment_response_ready", "build_execution_interrupted", "assessment_execution_interrupted", "pr_merged_at_accepted_head", "pr_closed_unmerged", "provision_outputs_ready", "provision_failed", "provision_execution_interrupted", "spec_outputs_ready", "spec_execution_interrupted", "plan_outputs_ready", "plan_execution_interrupted", "brief_outputs_ready", "brief_execution_interrupted", "final_outputs_ready", "final_execution_interrupted", "final_pr_merged_at_reviewed_head", "final_pr_closed_unmerged"] as const;
export type V15Fact = typeof V15_FACTS[number];
export const V15_BINDING_SOURCES = ["accepted_build", "assessment.interrupted.assessment", "assessment.interrupted.execution", "assessment.interrupted.work", "assessment.outputs.assessment", "assessment.work.input.accepted_build", "brief.interrupted.current", "brief.interrupted.execution", "brief.interrupted.work", "brief.outputs.briefs", "build.interrupted.build_result", "build.interrupted.execution", "build.interrupted.pr_summary", "build.interrupted.work", "build.outputs", "final_integration.interrupted.current", "final_integration.interrupted.execution", "inputs", "inputs.base_branch", "inputs.brief", "inputs.brief_notes", "inputs.completed_cohorts", "inputs.plan", "inputs.repositories", "inputs.repository", "inputs.spec_analysis", "observations.pr", "plan.interrupted.current", "plan.interrupted.execution", "plan.interrupted.work", "plan.outputs.plan", "provision.interrupted.execution", "request.feedback", "spec.interrupted.current", "spec.interrupted.execution", "spec.interrupted.work", "spec.outputs.spec_analysis"] as const;
export type V15BindingSource = typeof V15_BINDING_SOURCES[number];
export const V15_CHANGE_KINDS = ["set_cohort_state", "set_worker_state", "accept_outputs", "clear_acceptance", "fence_execution", "capture_accepted_build", "clear_accepted_build"] as const;
export type V15Change =
  | { readonly kind: "set_cohort_state"; readonly state: CohortState }
  | { readonly kind: "set_worker_state"; readonly worker: V15WorkerKey; readonly state: WorkerState }
  | { readonly kind: "accept_outputs" | "clear_acceptance" | "fence_execution"; readonly worker: V15WorkerKey }
  | { readonly kind: "capture_accepted_build" | "clear_accepted_build" };
export type V15WorkerAction =
  | { readonly worker: "build"; readonly action_point: "initial" | "revise" | "retry" | "replace_pr" }
  | { readonly worker: "assessment"; readonly action_point: "initial" | "discuss" | "retry" }
  | { readonly worker: "provision" | "final_integration"; readonly action_point: "initial" | "retry" }
  | { readonly worker: "spec" | "plan" | "brief"; readonly action_point: "initial" | "revise" | "retry" };
export type V15OperatorRequest =
  | { readonly kind: "accept_analysis" | "accept_plan" | "accept_briefs"; readonly target: ArtifactRef }
  | { readonly kind: "revise_analysis" | "revise_plan" | "revise_briefs"; readonly feedback: { readonly text: string; readonly target: ArtifactRef } }
  | { readonly kind: "retry_provision" | "retry_analysis" | "retry_plan" | "retry_briefs" | "retry_build" | "retry_assessment" | "retry_final_integration" | "confirm_merged" | "closed_without_merge" | "cancel" }
  | { readonly kind: "accept_build" | "accept_assessment" | "replace_pr"; readonly target: ArtifactRef }
  | { readonly kind: "request_build_changes" | "request_implementation_changes" | "discuss_assessment"; readonly feedback: { readonly text: string; readonly target: ArtifactRef } }
  | { readonly kind: "abandon"; readonly reason: string };
export type V15DecisionTree =
  | { readonly kind: "match_cohort" | "match_request"; readonly cases: Readonly<Record<string, V15DecisionTree>>; readonly otherwise: V15DecisionTree }
  | { readonly kind: "match_worker"; readonly worker: V15WorkerKey; readonly cases: Readonly<Record<string, V15DecisionTree>>; readonly otherwise: V15DecisionTree }
  | { readonly kind: "if"; readonly fact: V15Fact; readonly then: V15DecisionTree; readonly else: V15DecisionTree }
  | { readonly kind: "apply"; readonly changes: readonly V15Change[]; readonly actions: readonly V15WorkerAction[] }
  | { readonly kind: "wait" | "reject"; readonly reason: string };
