/** Named v15 contracts mirrored from docs/v15-contracts; evaluator vocabulary stays here. */
import type { ArtifactId, CohortId, CohortKey, CommitSha, ExecutionId, RepositoryKey, RequestId, SessionId, StageInstanceId, WorkflowRunId } from "./primitives";
import type { ArtifactRecord } from "./artifacts";
import type { AssessmentBody, BuildBriefBody, BuildResultBody, PlanBody, PrSummaryBody, SpecAnalysisBody } from "./dev-flow-artifacts";
export type WorkerState =
  | "pending"
  | "working"
  | "awaiting_review"
  | "accepted"
  | "interrupted"
  | "cancelled";

export type CohortState =
  | "pending"
  | "working"
  | "awaiting_merge"
  | "complete"
  | "failed"
  | "cancelled";

export type ArtifactState =
  | "unreviewed"
  | "accepted"
  | "changes_requested";


export interface ArtifactProvenance {
  execution_id: ExecutionId;
  session_id: SessionId | null;
}

export interface BuildWorker {
  state: WorkerState;
  outputs: {
    build_result: BuildResultArtifact | null;
    pr_summary: PrSummaryArtifact | null;
  };
  sessions: readonly BuildSession[];
}

export interface AssessmentWorker {
  state: WorkerState;
  outputs: {
    assessment: AssessmentArtifact | null;
  };
  sessions: readonly AssessmentSession[];
}

export interface BuildResultArtifact {
  id: ArtifactId;
  type: "dev.build_result";
  state: ArtifactState;
  version: number;
  body: BuildResultBody;
  provenance: ArtifactProvenance;
}

export interface PrSummaryArtifact {
  id: ArtifactId;
  type: "dev.pr_summary";
  state: ArtifactState;
  version: number;
  body: PrSummaryBody;
  provenance: ArtifactProvenance;
}

export interface AssessmentArtifact {
  id: ArtifactId;
  type: "dev.assessment";
  state: ArtifactState;
  version: number;
  body: AssessmentBody;
  provenance: ArtifactProvenance;
}

export type SessionState = "running" | "finished" | "interrupted" | "cancelled";

export interface BuildSession {
  id: SessionId;
  execution_id: ExecutionId;
  action_point: "initial" | "revise" | "retry" | "replace_pr";
  state: SessionState;
}

export interface AssessmentSession {
  id: SessionId;
  execution_id: ExecutionId;
  action_point: "initial" | "discuss" | "retry";
  state: SessionState;
}


export interface ImplementationCohortDefinition {
  workers: {
    build: BuildWorkerDefinition;
    assessment: AssessmentWorkerDefinition;
  };
  decision_tree: V15DecisionTree;
}

export interface BuildWorkerDefinition {
  execution: AgentExecutionDefinition;
  outputs: {
    build_result: { type: "dev.build_result"; revision: RevisionPolicy };
    pr_summary: { type: "dev.pr_summary"; revision: RevisionPolicy };
  };
  action_points: {
    initial: BuildInitialAction;
    revise: BuildReviseAction;
    retry: BuildRetryAction;
    replace_pr: BuildReplacePrAction;
  };
}

export interface AssessmentWorkerDefinition {
  execution: AgentExecutionDefinition;
  outputs: {
    assessment: { type: "dev.assessment"; revision: RevisionPolicy };
  };
  action_points: {
    initial: AssessmentInitialAction;
    discuss: AssessmentDiscussAction;
    retry: AssessmentRetryAction;
  };
}

export type RevisionPolicy = "update" | "replace";


export interface ArtifactRef {
  id: ArtifactId;
  version: number;
}

export interface BuildOutputRefs {
  build_result: ArtifactRef;
  pr_summary: ArtifactRef;
}

export interface AcceptedBuild {
  outputs: BuildOutputRefs;
  pr_url: string;
  head_sha: CommitSha;
}

export interface RepositoryRefsBody {
  repository_key: RepositoryKey;
  repository_path: string;
  integration_branch: string;
  base_branch: string;
  base_head_sha: CommitSha;
}

export interface ImplementationRepository {
  refs: RepositoryRefsBody;
  worktree_path: string;
  worktree_base_sha: CommitSha | null;
  canonical_branch: string;
  expected_pr_base: string;
}

export interface ImplementationCohortInputs {
  brief: ArtifactRef;
  repository: ImplementationRepository;
}

export interface PreparedImplementationRepository extends ImplementationRepository {
  worktree_base_sha: CommitSha;
}

export interface ImplementationCohortRecord {
  id: CohortId;
  key: CohortKey;
  version: number;
  state: CohortState;
  depends_on: readonly CohortId[];
  inputs: ImplementationCohortInputs;
  build: BuildWorkerRecord;
  assessment: AssessmentWorkerRecord;
  accepted_build: AcceptedBuild | null;
}


export interface BuildReviewTarget {
  outputs: BuildOutputRefs;
  head_sha: CommitSha;
}

export interface AssessmentReviewTarget {
  assessment: ArtifactRef;
  build: AcceptedBuild;
}

export type BuildFeedback =
  | { source: "build_review"; text: string; target: BuildReviewTarget }
  | { source: "assessment"; text: string; target: AssessmentReviewTarget };

export interface AssessmentFeedback {
  text: string;
  target: AssessmentReviewTarget;
}

export type OperatorRequest =
  | { kind: "accept_build"; target: BuildReviewTarget }
  | { kind: "request_build_changes"; feedback: Extract<BuildFeedback, { source: "build_review" }> }
  | { kind: "accept_assessment"; target: AssessmentReviewTarget }
  | { kind: "discuss_assessment"; feedback: AssessmentFeedback }
  | { kind: "request_implementation_changes"; feedback: Extract<BuildFeedback, { source: "assessment" }> }
  | { kind: "retry_build" }
  | { kind: "retry_assessment" }
  | { kind: "replace_pr"; target: BuildReviewTarget }
  | { kind: "cancel" }
  | { kind: "abandon"; reason: string };

export interface OperatorRequestEnvelope {
  id: RequestId;
  cohort_id: CohortId;
  expected_version: number;
  request: OperatorRequest;
}


export interface BuildInitialInput {
  brief: ArtifactRef;
  repository: PreparedImplementationRepository;
}

export interface BuildReviseInput extends BuildInitialInput {
  current_build: BuildOutputRefs;
  feedback: BuildFeedback;
}

export interface BuildReplacePrInput extends BuildInitialInput {
  current_build: BuildOutputRefs;
  closed_pr: VerifiedPrObservation;
}

export interface AssessmentInitialInput {
  brief: ArtifactRef;
  repository: PreparedImplementationRepository;
  accepted_build: AcceptedBuild;
}

export interface AssessmentDiscussInput extends AssessmentInitialInput {
  current_assessment: ArtifactRef;
  feedback: AssessmentFeedback;
}

export type BuildWorkInput =
  | { action_point: "initial"; input: BuildInitialInput }
  | { action_point: "revise"; input: BuildReviseInput }
  | { action_point: "replace_pr"; input: BuildReplacePrInput };

export type AssessmentWorkInput =
  | { action_point: "initial"; input: AssessmentInitialInput }
  | { action_point: "discuss"; input: AssessmentDiscussInput };

export interface InterruptedExecution {
  execution_id: ExecutionId;
  session_id: SessionId | null;
  detail: string;
}

export interface BuildRetryInput {
  work: BuildWorkInput;
  interrupted: InterruptedExecution;
  build_result: ArtifactRef | null;
  pr_summary: ArtifactRef | null;
}

export interface AssessmentRetryInput {
  work: AssessmentWorkInput;
  interrupted: InterruptedExecution;
  assessment: ArtifactRef | null;
}

export interface BuildResponse {
  execution_id: ExecutionId;
  build_result: ArtifactRef | null;
  pr_summary: ArtifactRef | null;
  head_sha: CommitSha | null;
}

export interface BuildInterruptedRecord {
  work: BuildWorkInput;
  execution: InterruptedExecution;
  build_result: ArtifactRef | null;
  pr_summary: ArtifactRef | null;
}

export interface AssessmentInterruptedRecord {
  work: AssessmentWorkInput;
  execution: InterruptedExecution;
  assessment: ArtifactRef | null;
}

export interface BuildWorkerRecord extends BuildWorker {
  active_execution_id: ExecutionId | null;
  work: BuildWorkInput | null;
  response: BuildResponse | null;
  interrupted: BuildInterruptedRecord | null;
}

export interface AssessmentWorkerRecord extends AssessmentWorker {
  active_execution_id: ExecutionId | null;
  work: AssessmentWorkInput | null;
  response: AssessmentResponse | null;
  interrupted: AssessmentInterruptedRecord | null;
}


export type BindingSource =
  | "inputs.brief"
  | "inputs.repository"
  | "build.outputs"
  | "request.feedback"
  | "build.interrupted.work"
  | "build.interrupted.execution"
  | "build.interrupted.build_result"
  | "build.interrupted.pr_summary"
  | "observations.pr"
  | "accepted_build"
  | "assessment.work.input.accepted_build"
  | "assessment.outputs.assessment"
  | "assessment.interrupted.work"
  | "assessment.interrupted.execution"
  | "assessment.interrupted.assessment";

export interface InputBinding {
  from: BindingSource;
}

export type InputBindings<Input> = { [Field in keyof Input]: InputBinding };

export interface PromptAction<Input> {
  prompt: string;
  inputs: InputBindings<Input>;
}

export type BuildInitialAction = PromptAction<BuildInitialInput>;
export type BuildReviseAction = PromptAction<BuildReviseInput>;
export type BuildRetryAction = PromptAction<BuildRetryInput>;
export type BuildReplacePrAction = PromptAction<BuildReplacePrInput>;
export type AssessmentInitialAction = PromptAction<AssessmentInitialInput>;
export type AssessmentDiscussAction = PromptAction<AssessmentDiscussInput>;
export type AssessmentRetryAction = PromptAction<AssessmentRetryInput>;


export interface VerifiedPrObservation {
  pr_url: string;
  repository_key: RepositoryKey;
  head_branch: string;
  base_branch: string;
  head_sha: CommitSha;
  state: "open" | "closed" | "merged";
}

export type AssessmentResponse =
  | { kind: "published"; execution_id: ExecutionId; assessment: ArtifactRef; build: AcceptedBuild }
  | { kind: "unchanged"; execution_id: ExecutionId; assessment: ArtifactRef; build: AcceptedBuild; explanation: string };


export type WorkerKey = "build" | "assessment";
export type RequestKind = OperatorRequest["kind"] | "none";
export type StateCases<State extends string> = { [Value in State]?: DecisionTree };

export type DecisionTree =
  | { kind: "match_cohort"; cases: StateCases<CohortState>; otherwise: DecisionTree }
  | { kind: "match_worker"; worker: WorkerKey; cases: StateCases<WorkerState>; otherwise: DecisionTree }
  | { kind: "match_request"; cases: StateCases<RequestKind>; otherwise: DecisionTree }
  | { kind: "if"; fact: CohortFact; then: DecisionTree; else: DecisionTree }
  | { kind: "apply"; changes: readonly CohortChange[]; actions: readonly WorkerAction[] }
  | { kind: "wait"; reason: string }
  | { kind: "reject"; reason: string };

export type CohortFact =
  | "build_outputs_ready"
  | "assessment_response_ready"
  | "build_execution_interrupted"
  | "assessment_execution_interrupted"
  | "pr_closed_unmerged"
  | "pr_merged_at_accepted_head";

export type CohortChange =
  | { kind: "set_cohort_state"; state: CohortState }
  | { kind: "set_worker_state"; worker: WorkerKey; state: WorkerState }
  | { kind: "accept_outputs"; worker: WorkerKey }
  | { kind: "clear_acceptance"; worker: WorkerKey }
  | { kind: "capture_accepted_build" }
  | { kind: "clear_accepted_build" }
  | { kind: "fence_execution"; worker: WorkerKey };

export type WorkerAction =
  | { worker: "build"; action_point: "initial" | "revise" | "retry" | "replace_pr" }
  | { worker: "assessment"; action_point: "initial" | "discuss" | "retry" };


export type ResolvedBuildAction =
  | BuildWorkInput
  | { action_point: "retry"; input: BuildRetryInput };

export type ResolvedAssessmentAction =
  | AssessmentWorkInput
  | { action_point: "retry"; input: AssessmentRetryInput };

export type ResolvedWorkerAction =
  | { worker: "build"; action: ResolvedBuildAction }
  | { worker: "assessment"; action: ResolvedAssessmentAction };

export type SelectedDecision =
  | { kind: "wait"; reason: string }
  | {
      kind: "apply";
      expected_version: number;
      changes: readonly CohortChange[];
      actions: readonly ResolvedWorkerAction[];
    };

export interface CohortDecisionError {
  kind: "invalid_definition" | "invalid_state" | "invalid_request" | "stale_review" | "unavailable_input";
  operation: "evaluate_cohort";
  cohort_id: CohortId;
  detail: string;
}


export type DefinitionVersion = number & { readonly definition_version: unique symbol };
export type RunId = WorkflowRunId;
export type StageId = StageInstanceId;

export type StageKey =
  | "repository_preparation"
  | "spec_analysis"
  | "planning"
  | "brief_writing"
  | "implementation"
  | "final_integration";

export type StageState = "pending" | "working" | "complete" | "failed" | "cancelled";
export type RunState = StageState;

export interface StageDefinition<Cohort> {
  prerequisites: readonly StageKey[];
  max_active_cohorts: number;
  cohort: Cohort;
}

export interface V15StageDefinitions {
  repository_preparation: StageDefinition<RepositoryPreparationCohortDefinition>;
  spec_analysis: StageDefinition<SpecAnalysisCohortDefinition>;
  planning: StageDefinition<PlanningCohortDefinition>;
  brief_writing: StageDefinition<BriefWritingCohortDefinition>;
  implementation: StageDefinition<ImplementationCohortDefinition>;
  final_integration: StageDefinition<FinalIntegrationCohortDefinition>;
}

export interface WorkflowDefinition {
  key: "dev_flow_v15";
  version: DefinitionVersion;
  stages: V15StageDefinitions;
}

export type AuthoredWorkflowDefinition = Omit<WorkflowDefinition, "version"> & { version: number };

export interface StageRecord<Cohort> {
  id: StageId;
  key: StageKey;
  version: number;
  state: StageState;
  prerequisites: readonly StageId[];
  cohorts: readonly Cohort[] | null;
}

export interface AgentSettings {
  runtime: "claude-code" | "codex";
  model: string | null;
  effort: string | null;
}

export interface RunRepository {
  key: RepositoryKey;
  path: string;
  integration_branch: string;
  forge_repository: ForgeRepositoryIdentity | null;
}

export interface ForgeRepositoryIdentity {
  provider: "github";
  owner: string;
  name: string;
}

export interface V15RunInputs {
  brief_notes: string;
  repositories: readonly RunRepository[];
  base_branch: string;
  planner: AgentSettings;
  builder: AgentSettings;
}

export interface AgentExecutionDefinition {
  settings: { from: "run.planner" | "run.builder" };
  pre_authorized_tools: readonly string[];
  required_tools: readonly string[];
  yolo: boolean;
}


export interface OutputDeclaration<Type extends string> {
  type: Type;
  revision: RevisionPolicy;
}

export interface BriefOutputDeclaration extends OutputDeclaration<"dev.build_brief"> {
  collection_key: "cohort_id";
}

export interface PromptWorkerDefinition<Outputs, Actions> {
  execution: AgentExecutionDefinition;
  outputs: Outputs;
  action_points: Actions;
}

export interface ReviewActions<Initial, Revision, Retry> {
  initial: V15PromptAction<Initial>;
  revise: V15PromptAction<Revision>;
  retry: V15PromptAction<Retry>;
}

export interface SpecOutputsDefinition {
  spec_analysis: OutputDeclaration<"dev.spec_analysis">;
}

export interface PlanOutputsDefinition {
  plan: OutputDeclaration<"dev.plan">;
}

export interface BriefOutputsDefinition {
  briefs: BriefOutputDeclaration;
}

export interface FinalOutputsDefinition {
  pr_summary: OutputDeclaration<"dev.pr_summary">;
}

export type SpecWorkerDefinition = PromptWorkerDefinition<
  SpecOutputsDefinition,
  ReviewActions<SpecAnalysisInputs, SpecRevisionInput, ArtifactRetryInput<SpecWorkInput>>
>;

export type PlanWorkerDefinition = PromptWorkerDefinition<
  PlanOutputsDefinition,
  ReviewActions<PlanningInputs, PlanRevisionInput, ArtifactRetryInput<PlanWorkInput>>
>;

export type BriefWorkerDefinition = PromptWorkerDefinition<
  BriefOutputsDefinition,
  ReviewActions<BriefWritingInputs, BriefRevisionInput, BriefRetryInput>
>;

export interface FinalActions {
  initial: V15PromptAction<FinalIntegrationInputs>;
  retry: V15PromptAction<FinalRetryInput>;
}

export type FinalWorkerDefinition = PromptWorkerDefinition<FinalOutputsDefinition, FinalActions>;

export interface ProvisionActions {
  initial: V15OperationAction<RepositoryPreparationInputs>;
  retry: V15OperationAction<ProvisionRetryInput>;
}

export interface ProvisionWorkerDefinition {
  outputs: { repository_refs: OutputDeclaration<"dev.repository_refs"> };
  action_points: ProvisionActions;
}

export interface RepositoryPreparationCohortDefinition {
  workers: { provision: ProvisionWorkerDefinition };
  decision_tree: V15DecisionTree;
}

export interface SpecAnalysisCohortDefinition {
  workers: { spec: SpecWorkerDefinition };
  decision_tree: V15DecisionTree;
}

export interface PlanningCohortDefinition {
  workers: { plan: PlanWorkerDefinition };
  decision_tree: V15DecisionTree;
}

export interface BriefWritingCohortDefinition {
  workers: { brief: BriefWorkerDefinition };
  decision_tree: V15DecisionTree;
}

export interface FinalIntegrationCohortDefinition {
  workers: { final_integration: FinalWorkerDefinition };
  decision_tree: V15DecisionTree;
}


export interface PreparedRepositoryArtifact {
  repository_key: RepositoryKey;
  ref: ArtifactRef;
}

export interface RepositoryPreparationInputs {
  repository: RunRepository;
  base_branch: string;
}

export interface SpecAnalysisInputs {
  brief_notes: string;
  repositories: readonly PreparedRepositoryArtifact[];
}

export interface PlanningInputs {
  spec_analysis: ArtifactRef;
  repositories: readonly PreparedRepositoryArtifact[];
}

export interface BriefWritingInputs {
  plan: ArtifactRef;
  repositories: readonly PreparedRepositoryArtifact[];
}

export interface BriefCollectionMember {
  cohort_key: CohortKey;
  ref: ArtifactRef;
}

export interface BriefCollection {
  members: readonly BriefCollectionMember[];
}

export interface CompletedImplementation {
  cohort_key: CohortKey;
  repository_key: RepositoryKey;
  brief: ArtifactRef;
  build: AcceptedBuild;
  assessment: ArtifactRef;
}

export interface FinalIntegrationInputs {
  repository: RepositoryRefsBody;
  completed_cohorts: readonly CompletedImplementation[];
}

export interface FinalPrReviewTarget {
  pr_summary: ArtifactRef;
  pr_url: string;
  head_sha: CommitSha;
}


export interface ArtifactFeedback {
  text: string;
  target: ArtifactRef;
}

export interface BriefFeedback {
  text: string;
  target: BriefCollection;
}

export interface SpecRevisionInput {
  original: SpecAnalysisInputs;
  current: ArtifactRef;
  feedback: ArtifactFeedback;
}

export interface PlanRevisionInput {
  original: PlanningInputs;
  current: ArtifactRef;
  feedback: ArtifactFeedback;
}

export interface BriefRevisionInput {
  original: BriefWritingInputs;
  current: BriefCollection;
  feedback: BriefFeedback;
}

export type SpecWorkInput =
  | { action_point: "initial"; input: SpecAnalysisInputs }
  | { action_point: "revise"; input: SpecRevisionInput };

export type PlanWorkInput =
  | { action_point: "initial"; input: PlanningInputs }
  | { action_point: "revise"; input: PlanRevisionInput };

export type BriefWorkInput =
  | { action_point: "initial"; input: BriefWritingInputs }
  | { action_point: "revise"; input: BriefRevisionInput };

export interface ArtifactRetryInput<Work> {
  work: Work;
  interrupted: InterruptedExecution;
  current: ArtifactRef | null;
}

export interface BriefRetryInput {
  work: BriefWorkInput;
  interrupted: InterruptedExecution;
  current: BriefCollection;
}

export interface ProvisionRetryInput {
  original: RepositoryPreparationInputs;
  interrupted: InterruptedExecution;
}

export interface FinalRetryInput {
  original: FinalIntegrationInputs;
  interrupted: InterruptedExecution;
  current: ArtifactRef | null;
}


export interface AgentSession<ActionPoint extends string> {
  id: SessionId;
  execution_id: ExecutionId;
  action_point: ActionPoint;
  state: SessionState;
}

export interface ReviewResponse<Current> {
  execution_id: ExecutionId;
  current: Current;
}

export interface ReviewInterruption<Work, Current> {
  work: Work;
  execution: InterruptedExecution;
  current: Current;
}

export interface ReviewWorkerRecord<Work, Outputs, Current, ActionPoint extends string> {
  state: WorkerState;
  active_execution_id: ExecutionId | null;
  work: Work | null;
  outputs: Outputs;
  response: ReviewResponse<Current> | null;
  interrupted: ReviewInterruption<Work, Current> | null;
  sessions: readonly AgentSession<ActionPoint>[];
}

export interface SpecStoredOutputs { spec_analysis: SpecAnalysisArtifact | null }
export interface PlanStoredOutputs { plan: PlanArtifact | null }
export interface BriefStoredMember { cohort_key: CohortKey; artifact: BuildBriefArtifact }
export interface BriefStoredOutputs { briefs: readonly BriefStoredMember[] }
export interface FinalStoredOutputs { pr_summary: PrSummaryArtifact | null }

export type SpecWorkerRecord = ReviewWorkerRecord<SpecWorkInput, SpecStoredOutputs, ArtifactRef | null, "initial" | "revise" | "retry">;
export type PlanWorkerRecord = ReviewWorkerRecord<PlanWorkInput, PlanStoredOutputs, ArtifactRef | null, "initial" | "revise" | "retry">;
export type BriefWorkerRecord = ReviewWorkerRecord<BriefWorkInput, BriefStoredOutputs, BriefCollection, "initial" | "revise" | "retry">;
export interface FinalWorkInput { action_point: "initial"; input: FinalIntegrationInputs }
export type FinalWorkerRecord = ReviewWorkerRecord<FinalWorkInput, FinalStoredOutputs, ArtifactRef | null, "initial" | "retry">;

export interface RepositoryRefsArtifact {
  id: ArtifactId;
  type: "dev.repository_refs";
  version: number;
  state: ArtifactState;
  body: RepositoryRefsBody;
  provenance: ArtifactProvenance;
}

export interface ProvisionFailure {
  operation: "provision_repository_refs";
  cohort_id: CohortId;
  repository_key: RepositoryKey;
  detail: string;
  kind: "not_a_git_repository" | "missing_integration_branch" | "base_branch_unavailable" | "git_command_failed";
}

export type ProvisionOutcome =
  | { kind: "succeeded"; output: ArtifactRef }
  | { kind: "failed"; failure: ProvisionFailure };

export interface ProvisionResponse {
  execution_id: ExecutionId;
  outcome: ProvisionOutcome;
}

export interface ProvisionExecution {
  execution_id: ExecutionId;
  action_point: "initial" | "retry";
  state: SessionState;
  outcome: ProvisionOutcome | null;
}

export interface ProvisionWorkerRecord {
  state: WorkerState;
  active_execution_id: ExecutionId | null;
  outputs: { repository_refs: RepositoryRefsArtifact | null };
  response: ProvisionResponse | null;
  interrupted: { execution: InterruptedExecution } | null;
  executions: readonly ProvisionExecution[];
}

export type StageCohortKey = RepositoryKey | CohortKey | "spec_analysis" | "planning" | "brief_writing";

export interface CohortRecordBase<Inputs> {
  id: CohortId;
  key: StageCohortKey;
  version: number;
  state: CohortState;
  depends_on: readonly CohortId[];
  inputs: Inputs;
}

export interface RepositoryPreparationCohortRecord extends CohortRecordBase<RepositoryPreparationInputs> {
  provision: ProvisionWorkerRecord;
}
export interface SpecAnalysisCohortRecord extends CohortRecordBase<SpecAnalysisInputs> {
  spec: SpecWorkerRecord;
}
export interface PlanningCohortRecord extends CohortRecordBase<PlanningInputs> {
  plan: PlanWorkerRecord;
}
export interface BriefWritingCohortRecord extends CohortRecordBase<BriefWritingInputs> {
  brief: BriefWorkerRecord;
}
export interface FinalIntegrationCohortRecord extends CohortRecordBase<FinalIntegrationInputs> {
  final_integration: FinalWorkerRecord;
}

export interface V15StageRecords {
  repository_preparation: StageRecord<RepositoryPreparationCohortRecord>;
  spec_analysis: StageRecord<SpecAnalysisCohortRecord>;
  planning: StageRecord<PlanningCohortRecord>;
  brief_writing: StageRecord<BriefWritingCohortRecord>;
  implementation: StageRecord<ImplementationCohortRecord>;
  final_integration: StageRecord<FinalIntegrationCohortRecord>;
}

export interface V15RunRecord {
  id: RunId;
  version: number;
  state: RunState;
  definition_version: DefinitionVersion;
  inputs: V15RunInputs;
  stages: V15StageRecords;
}


export type V15BindingSource =
  | "accepted_build"
  | "assessment.interrupted.assessment"
  | "assessment.interrupted.execution"
  | "assessment.interrupted.work"
  | "assessment.outputs.assessment"
  | "assessment.work.input.accepted_build"
  | "brief.interrupted.current"
  | "brief.interrupted.execution"
  | "brief.interrupted.work"
  | "brief.outputs.briefs"
  | "build.interrupted.build_result"
  | "build.interrupted.execution"
  | "build.interrupted.pr_summary"
  | "build.interrupted.work"
  | "build.outputs"
  | "final_integration.interrupted.current"
  | "final_integration.interrupted.execution"
  | "inputs"
  | "inputs.base_branch"
  | "inputs.brief"
  | "inputs.brief_notes"
  | "inputs.completed_cohorts"
  | "inputs.plan"
  | "inputs.repositories"
  | "inputs.repository"
  | "inputs.spec_analysis"
  | "observations.pr"
  | "plan.interrupted.current"
  | "plan.interrupted.execution"
  | "plan.interrupted.work"
  | "plan.outputs.plan"
  | "provision.interrupted.execution"
  | "request.feedback"
  | "spec.interrupted.current"
  | "spec.interrupted.execution"
  | "spec.interrupted.work"
  | "spec.outputs.spec_analysis";

export interface V15InputBinding {
  from: V15BindingSource;
}

export type V15InputBindings<Input> = { [Field in keyof Input]: V15InputBinding };

export interface V15PromptAction<Input> {
  prompt: string;
  inputs: V15InputBindings<Input>;
}

export interface V15OperationAction<Input> {
  operation: "provision_repository_refs";
  inputs: V15InputBindings<Input>;
}


export type V15OperatorRequest =
  | OperatorRequest
  | { kind: "accept_analysis"; target: ArtifactRef }
  | { kind: "revise_analysis"; feedback: ArtifactFeedback }
  | { kind: "retry_analysis" }
  | { kind: "accept_plan"; target: ArtifactRef }
  | { kind: "revise_plan"; feedback: ArtifactFeedback }
  | { kind: "retry_plan" }
  | { kind: "accept_briefs"; target: BriefCollection }
  | { kind: "revise_briefs"; feedback: BriefFeedback }
  | { kind: "retry_briefs" }
  | { kind: "retry_provision" }
  | { kind: "retry_final_integration" }
  | { kind: "confirm_merged"; target: FinalPrReviewTarget }
  | { kind: "closed_without_merge"; target: FinalPrReviewTarget };

export type V15OperatorRequestEnvelope = Omit<OperatorRequestEnvelope, "request"> & {
  request: V15OperatorRequest;
};


export type V15WorkerKey = "provision" | "spec" | "plan" | "brief" | "build" | "assessment" | "final_integration";
export type V15RequestKind = V15OperatorRequest["kind"] | "none";
export type V15StateCases<State extends string> = { [Value in State]?: V15DecisionTree };

export type V15Fact =
  | CohortFact
  | "provision_outputs_ready" | "provision_failed" | "provision_execution_interrupted"
  | "spec_outputs_ready" | "spec_execution_interrupted"
  | "plan_outputs_ready" | "plan_execution_interrupted"
  | "brief_outputs_ready" | "brief_execution_interrupted"
  | "final_outputs_ready" | "final_execution_interrupted"
  | "final_pr_merged_at_reviewed_head" | "final_pr_closed_unmerged";

export type V15Change =
  | { kind: "set_cohort_state"; state: CohortState }
  | { kind: "set_worker_state"; worker: V15WorkerKey; state: WorkerState }
  | { kind: "accept_outputs"; worker: V15WorkerKey }
  | { kind: "clear_acceptance"; worker: V15WorkerKey }
  | { kind: "fence_execution"; worker: V15WorkerKey }
  | { kind: "capture_accepted_build" }
  | { kind: "clear_accepted_build" };

export type V15WorkerAction =
  | WorkerAction
  | { worker: "provision"; action_point: "initial" | "retry" }
  | { worker: "spec" | "plan" | "brief"; action_point: "initial" | "revise" | "retry" }
  | { worker: "final_integration"; action_point: "initial" | "retry" };

export type V15DecisionTree =
  | { kind: "match_cohort"; cases: V15StateCases<CohortState>; otherwise: V15DecisionTree }
  | { kind: "match_worker"; worker: V15WorkerKey; cases: V15StateCases<WorkerState>; otherwise: V15DecisionTree }
  | { kind: "match_request"; cases: V15StateCases<V15RequestKind>; otherwise: V15DecisionTree }
  | { kind: "if"; fact: V15Fact; then: V15DecisionTree; else: V15DecisionTree }
  | { kind: "apply"; changes: readonly V15Change[]; actions: readonly V15WorkerAction[] }
  | { kind: "wait"; reason: string }
  | { kind: "reject"; reason: string };


export interface PublicationIdentity {
  request_id: RequestId;
  run_id: RunId;
  stage_id: StageId;
  cohort_id: CohortId;
  execution_id: ExecutionId;
  session_id: SessionId | null;
}

export type ArtifactPublication =
  | { output: "repository_refs"; body: RepositoryRefsBody; expected: ArtifactRef | null }
  | { output: "spec_analysis"; body: SpecAnalysisBody; expected: ArtifactRef | null }
  | { output: "plan"; body: PlanBody; expected: ArtifactRef | null }
  | { output: "briefs"; member_key: CohortKey; body: BuildBriefBody; expected: ArtifactRef | null }
  | { output: "build_result"; body: BuildResultBody; head_sha: CommitSha; expected: ArtifactRef | null }
  | { output: "pr_summary"; body: PrSummaryBody; head_sha: CommitSha; expected: ArtifactRef | null }
  | { output: "assessment"; body: AssessmentBody; build: AcceptedBuild; expected: ArtifactRef | null };

export type WorkerPublication =
  | { kind: "artifact"; identity: PublicationIdentity; publication: ArtifactPublication }
  | {
      kind: "assessment_unchanged";
      identity: PublicationIdentity;
      assessment: ArtifactRef;
      build: AcceptedBuild;
      explanation: string;
    };


export interface SpecAnalysisArtifact { id: ArtifactId; type: "dev.spec_analysis"; version: number; state: ArtifactState; body: SpecAnalysisBody; provenance: ArtifactProvenance }
export interface PlanArtifact { id: ArtifactId; type: "dev.plan"; version: number; state: ArtifactState; body: PlanBody; provenance: ArtifactProvenance }
export interface BuildBriefArtifact { id: ArtifactId; type: "dev.build_brief"; version: number; state: ArtifactState; body: BuildBriefBody; provenance: ArtifactProvenance }
export type AcceptanceMetadata = "unreviewed" | "accepted" | "changes_requested";
/** ArtifactRef.id -> artifact.chain_id; ArtifactRef.version -> artifact.revision. */
export const artifactRefFromRevision = (artifact: Pick<ArtifactRecord, "chain_id" | "revision">): ArtifactRef => ({ id: artifact.chain_id, version: artifact.revision });

export const V15_WORKER_KEYS = ["provision", "spec", "plan", "brief", "build", "assessment", "final_integration"] as const;
export const V15_FACTS = ["build_outputs_ready", "assessment_response_ready", "build_execution_interrupted", "assessment_execution_interrupted", "pr_merged_at_accepted_head", "pr_closed_unmerged", "provision_outputs_ready", "provision_failed", "provision_execution_interrupted", "spec_outputs_ready", "spec_execution_interrupted", "plan_outputs_ready", "plan_execution_interrupted", "brief_outputs_ready", "brief_execution_interrupted", "final_outputs_ready", "final_execution_interrupted", "final_pr_merged_at_reviewed_head", "final_pr_closed_unmerged"] as const;
export const V15_BINDING_SOURCES = ["accepted_build", "assessment.interrupted.assessment", "assessment.interrupted.execution", "assessment.interrupted.work", "assessment.outputs.assessment", "assessment.work.input.accepted_build", "brief.interrupted.current", "brief.interrupted.execution", "brief.interrupted.work", "brief.outputs.briefs", "build.interrupted.build_result", "build.interrupted.execution", "build.interrupted.pr_summary", "build.interrupted.work", "build.outputs", "final_integration.interrupted.current", "final_integration.interrupted.execution", "inputs", "inputs.base_branch", "inputs.brief", "inputs.brief_notes", "inputs.completed_cohorts", "inputs.plan", "inputs.repositories", "inputs.repository", "inputs.spec_analysis", "observations.pr", "plan.interrupted.current", "plan.interrupted.execution", "plan.interrupted.work", "plan.outputs.plan", "provision.interrupted.execution", "request.feedback", "spec.interrupted.current", "spec.interrupted.execution", "spec.interrupted.work", "spec.outputs.spec_analysis"] as const;
export const V15_CHANGE_KINDS = ["set_cohort_state", "set_worker_state", "accept_outputs", "clear_acceptance", "fence_execution", "capture_accepted_build", "clear_accepted_build"] as const;

// The runtime checked vocabularies must remain exhaustive over the contract unions.
type CompleteVocabulary<Declared, Checked extends Declared> = [Exclude<Declared, Checked>] extends [never] ? true : never;
const checkedVocabularyCoverage: readonly [
  CompleteVocabulary<V15WorkerKey, typeof V15_WORKER_KEYS[number]>,
  CompleteVocabulary<V15Fact, typeof V15_FACTS[number]>,
  CompleteVocabulary<V15BindingSource, typeof V15_BINDING_SOURCES[number]>,
  CompleteVocabulary<V15Change["kind"], typeof V15_CHANGE_KINDS[number]>,
] = [true, true, true, true];
void checkedVocabularyCoverage;
