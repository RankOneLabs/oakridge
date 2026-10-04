# Complete v15 workflow contract

This is the concrete contract for rebuilding v15 in TypeScript on Bun. It completes the [artifact schema](oakridge-workflow-schema.md), [implementation cohort](oakridge-implementation-cohort-schema.md), and [refactor specification](oakridge-workflow-refactor-spec.md). The [serialized workflow](oakridge-v15-workflow-definition.json) contains all six stages, their locally owned cohort definitions, workers, action points, output declarations, bindings, and trees.

V15 has a clean cutover. There is one new execution model and no legacy interpreter, old-run conversion, or compatibility path. All artifact revisions retain identity and increment content version. Operator acceptance is authoritative, including for a failing assessment. A stage stops and cancels its unfinished cohorts when any cohort fails or is cancelled. Empty plans are invalid; repositories unused by the accepted plan do not get final integration cohorts.

## Workflow and stage definitions

Each v15 stage uses one kind of cohort, so its definition contains a `cohort` field. Its execution record contains the instantiated `cohorts`. Definitions own configuration; records own state. No schema, capability, or cohort registry lives on the workflow.

```ts
type DefinitionVersion = number & { readonly definition_version: unique symbol };
type RunId = string & { readonly run_id: unique symbol };
type StageId = string & { readonly stage_id: unique symbol };

type StageKey =
  | "repository_preparation"
  | "spec_analysis"
  | "planning"
  | "brief_writing"
  | "implementation"
  | "final_integration";

type StageState = "pending" | "working" | "complete" | "failed" | "cancelled";
type RunState = StageState;

interface StageDefinition<Cohort> {
  prerequisites: readonly StageKey[];
  max_active_cohorts: number;
  cohort: Cohort;
}

interface V15StageDefinitions {
  repository_preparation: StageDefinition<RepositoryPreparationCohortDefinition>;
  spec_analysis: StageDefinition<SpecAnalysisCohortDefinition>;
  planning: StageDefinition<PlanningCohortDefinition>;
  brief_writing: StageDefinition<BriefWritingCohortDefinition>;
  implementation: StageDefinition<ImplementationCohortDefinition>;
  final_integration: StageDefinition<FinalIntegrationCohortDefinition>;
}

interface WorkflowDefinition {
  key: "dev_flow_v15";
  version: DefinitionVersion;
  stages: V15StageDefinitions;
}

type AuthoredWorkflowDefinition = Omit<WorkflowDefinition, "version"> & { version: number };

interface StageRecord<Cohort> {
  id: StageId;
  key: StageKey;
  version: number;
  state: StageState;
  prerequisites: readonly StageId[];
  cohorts: readonly Cohort[] | null;
}

interface AgentSettings {
  runtime: "claude-code" | "codex";
  model: string | null;
  effort: string | null;
}

interface RunRepository {
  key: RepositoryKey;
  path: string;
  integration_branch: string;
  forge_repository: ForgeRepositoryIdentity | null;
}

interface ForgeRepositoryIdentity {
  provider: "github";
  owner: string;
  name: string;
}

interface V15RunInputs {
  brief_notes: string;
  repositories: readonly RunRepository[];
  base_branch: string;
  planner: AgentSettings;
  builder: AgentSettings;
}

interface AgentExecutionDefinition {
  settings: { from: "run.planner" | "run.builder" };
  pre_authorized_tools: readonly string[];
  required_tools: readonly string[];
  yolo: boolean;
}
```

Run repositories are nonempty, have unique keys, and are frozen at run creation. Validate branch names and repository paths before provisioning. `base_branch` is supplied once for the run, as in the existing repository-provisioning contract. A nullable model or effort means the selected runtime's default, not the string `"null"`.

Each LLM worker definition includes `execution: AgentExecutionDefinition`. Spec, plan, brief, and assessment use `run.planner`; build and final integration use `run.builder`. The v15 definition keeps the existing empty tool lists and `yolo: false`. The runtime resolves these settings before durable dispatch and preserves them with the execution intent. These are execution settings, not a capability-definition registry.

The concrete definition types are:

```ts
interface OutputDeclaration<Type extends string> {
  type: Type;
  revision: RevisionPolicy;
}

interface BriefOutputDeclaration extends OutputDeclaration<"dev.build_brief"> {
  collection_key: "cohort_id";
}

interface PromptWorkerDefinition<Outputs, Actions> {
  execution: AgentExecutionDefinition;
  outputs: Outputs;
  action_points: Actions;
}

interface ReviewActions<Initial, Revision, Retry> {
  initial: V15PromptAction<Initial>;
  revise: V15PromptAction<Revision>;
  retry: V15PromptAction<Retry>;
}

interface SpecOutputsDefinition {
  spec_analysis: OutputDeclaration<"dev.spec_analysis">;
}

interface PlanOutputsDefinition {
  plan: OutputDeclaration<"dev.plan">;
}

interface BriefOutputsDefinition {
  briefs: BriefOutputDeclaration;
}

interface FinalOutputsDefinition {
  pr_summary: OutputDeclaration<"dev.pr_summary">;
}

type SpecWorkerDefinition = PromptWorkerDefinition<
  SpecOutputsDefinition,
  ReviewActions<SpecAnalysisInputs, SpecRevisionInput, ArtifactRetryInput<SpecWorkInput>>
>;

type PlanWorkerDefinition = PromptWorkerDefinition<
  PlanOutputsDefinition,
  ReviewActions<PlanningInputs, PlanRevisionInput, ArtifactRetryInput<PlanWorkInput>>
>;

type BriefWorkerDefinition = PromptWorkerDefinition<
  BriefOutputsDefinition,
  ReviewActions<BriefWritingInputs, BriefRevisionInput, BriefRetryInput>
>;

interface FinalActions {
  initial: V15PromptAction<FinalIntegrationInputs>;
  retry: V15PromptAction<FinalRetryInput>;
}

type FinalWorkerDefinition = PromptWorkerDefinition<FinalOutputsDefinition, FinalActions>;

interface ProvisionActions {
  initial: V15OperationAction<RepositoryPreparationInputs>;
  retry: V15OperationAction<ProvisionRetryInput>;
}

interface ProvisionWorkerDefinition {
  outputs: { repository_refs: OutputDeclaration<"dev.repository_refs"> };
  action_points: ProvisionActions;
}

interface RepositoryPreparationCohortDefinition {
  workers: { provision: ProvisionWorkerDefinition };
  decision_tree: V15DecisionTree;
}

interface SpecAnalysisCohortDefinition {
  workers: { spec: SpecWorkerDefinition };
  decision_tree: V15DecisionTree;
}

interface PlanningCohortDefinition {
  workers: { plan: PlanWorkerDefinition };
  decision_tree: V15DecisionTree;
}

interface BriefWritingCohortDefinition {
  workers: { brief: BriefWorkerDefinition };
  decision_tree: V15DecisionTree;
}

interface FinalIntegrationCohortDefinition {
  workers: { final_integration: FinalWorkerDefinition };
  decision_tree: V15DecisionTree;
}
```

Each cohort also has a stage-local key, an opaque `CohortId`, a state, and a version. Singleton review cohorts use the literal keys `spec_analysis`, `planning`, and `brief_writing`; repository-bound cohorts use repository keys; implementation cohorts use planned cohort keys. Keys are scoped by stage. Workers start `pending`, with absent outputs, no current execution, and empty session history.

## Cohort creation

Cohort creation is a named, typed v15 transform for each stage. It produces records using that stage's `cohort` definition and pins their input references. The coordinator asks for stage initialization; these transforms perform the application-specific data mapping. No configurable source expression, pointer lookup language, or `cohorts_from` field is required for v15.

| Stage | Prerequisites | Instances and pinned inputs | Maximum active |
| --- | --- | --- | --- |
| repository_preparation | None | One per run repository; repository entry and run base branch. | 4 |
| spec_analysis | repository_preparation | One; brief notes and the full prepared repository-ref collection. | 1 |
| planning | spec_analysis, repository_preparation | One; accepted analysis and prepared repository refs. | 1 |
| brief_writing | planning, repository_preparation | One; accepted plan and prepared repository refs. | 1 |
| implementation | brief_writing, repository_preparation | One per accepted brief; exact brief version, matching repository refs, reserved worktree location and branch roles. | 4 |
| final_integration | implementation, repository_preparation | One per repository referenced by the accepted plan; repository refs and completed implementation results for that repository. | 4 |

Before initialization, a stage's `cohorts` is null. Materialize a stage once, after every prerequisite completes. Freeze its nonempty cohort membership and pinned inputs. Persist membership atomically with stage initialization, with uniqueness on stage and cohort key. Replay returns the same records; it does not produce new IDs or duplicate work. Invalid mapping fails initialization with a typed error and does not leave a partially activated stage. Cancelling an uninitialized stage does not create cohorts merely to cancel them.

The accepted plan must contain at least one cohort. Every repository assignment must identify a supplied repository. Briefs must cover exactly the plan's cohort keys and preserve repository assignments, dependency sets, and acceptance criteria. Match repositories by validated keys, never by array position. `depends_on` alone defines implementation prerequisites; dependencies may cross repositories and must be known, unique, non-self, and acyclic. Preserve accepted plan order only as a deterministic tie-break between otherwise eligible cohorts; it creates no prerequisite and needs no `dependency_order` field.

The implementation cohort's canonical branch remains `cohort/<stage-id>/<cohort-key>` and its PR base is the run's repository `base_branch`. Validate that the keys produce a legal branch/path; do not silently sanitize them into collisions. Translate brief dependency keys into frozen runtime `CohortId` prerequisites during materialization; the scheduler reads those prerequisites without interpreting brief bodies. Create or recover the corresponding worktree before worker dispatch. After predecessor cohorts merge, prepare initial work from the current run-base head and record that exact worktree base commit. The original repository-ref `base_head_sha` is provisioning evidence, not the base for every later dependent build. Revisions and retries preserve their prepared worktree. Worktree preparation is a durable prerequisite of dispatch, not a second application decision authority.

At materialization, `worktree_base_sha` is null. For an eligible implementation cohort, the preparation boundary observes the current base, prepares or recovers the worktree idempotently, and records its actual base commit before initial evaluation and dispatch. That supplies `PreparedImplementationRepository` to action bindings. Artifact input versions, dependency membership, paths, and branch assignments stay frozen; preparation fills the initially absent operational value. Activation rejects missing preparation. A failed preparation is a typed failed-cohort observation; a lost preparation attempt is recoverable without starting an LLM session.

Final integration consumes completed outputs grouped by cohort key, not three independent arrays whose positions happen to align. Omit repositories unused by the accepted plan. At least one final cohort therefore exists. No v15 stage intentionally has an empty cohort set; an empty result is a contract error rather than vacuous completion.

Accepted upstream stages cannot be reopened in the same v15 run. Their workers are terminal and their accepted input versions stay pinned downstream. Changes to accepted analysis, plan, or brief membership require a new run. Revisions before acceptance stay within the current worker and do not create downstream cohorts early.

## Concrete cohort inputs

Artifact references use the `ArtifactRef` contract in the implementation-cohort schema. Collection members retain their own artifact identity and version.

```ts
interface PreparedRepositoryArtifact {
  repository_key: RepositoryKey;
  ref: ArtifactRef;
}

interface RepositoryPreparationInputs {
  repository: RunRepository;
  base_branch: string;
}

interface SpecAnalysisInputs {
  brief_notes: string;
  repositories: readonly PreparedRepositoryArtifact[];
}

interface PlanningInputs {
  spec_analysis: ArtifactRef;
  repositories: readonly PreparedRepositoryArtifact[];
}

interface BriefWritingInputs {
  plan: ArtifactRef;
  repositories: readonly PreparedRepositoryArtifact[];
}

interface BriefCollectionMember {
  cohort_key: CohortKey;
  ref: ArtifactRef;
}

interface BriefCollection {
  members: readonly BriefCollectionMember[];
}

interface CompletedImplementation {
  cohort_key: CohortKey;
  repository_key: RepositoryKey;
  brief: ArtifactRef;
  build: AcceptedBuild;
  assessment: ArtifactRef;
}

interface FinalIntegrationInputs {
  repository: RepositoryRefsBody;
  completed_cohorts: readonly CompletedImplementation[];
}

interface FinalPrReviewTarget {
  pr_summary: ArtifactRef;
  pr_url: string;
  head_sha: CommitSha;
}
```

Repository refs have the payload already specified in the implementation-cohort schema and use artifact type `dev.repository_refs`. Provisioning outputs are not operator-reviewed. Valid operation completion plus a valid refs output accepts the provision worker mechanically. This does not make LLM publication an automatic acceptance.

For analysis, planning, and brief writing, revision payloads contain their original cohort inputs, current output reference or brief collection, and `{text, target}` feedback. Retry payloads contain the original initial/revise work, interrupted execution, and valid partial publication references. These follow the same retained-original-work rule as build and assessment retries.

```ts
interface ArtifactFeedback {
  text: string;
  target: ArtifactRef;
}

interface BriefFeedback {
  text: string;
  target: BriefCollection;
}

interface SpecRevisionInput {
  original: SpecAnalysisInputs;
  current: ArtifactRef;
  feedback: ArtifactFeedback;
}

interface PlanRevisionInput {
  original: PlanningInputs;
  current: ArtifactRef;
  feedback: ArtifactFeedback;
}

interface BriefRevisionInput {
  original: BriefWritingInputs;
  current: BriefCollection;
  feedback: BriefFeedback;
}

type SpecWorkInput =
  | { action_point: "initial"; input: SpecAnalysisInputs }
  | { action_point: "revise"; input: SpecRevisionInput };

type PlanWorkInput =
  | { action_point: "initial"; input: PlanningInputs }
  | { action_point: "revise"; input: PlanRevisionInput };

type BriefWorkInput =
  | { action_point: "initial"; input: BriefWritingInputs }
  | { action_point: "revise"; input: BriefRevisionInput };

interface ArtifactRetryInput<Work> {
  work: Work;
  interrupted: InterruptedExecution;
  current: ArtifactRef | null;
}

interface BriefRetryInput {
  work: BriefWorkInput;
  interrupted: InterruptedExecution;
  current: BriefCollection;
}

interface ProvisionRetryInput {
  original: RepositoryPreparationInputs;
  interrupted: InterruptedExecution;
}

interface FinalRetryInput {
  original: FinalIntegrationInputs;
  interrupted: InterruptedExecution;
  current: ArtifactRef | null;
}
```

An empty `BriefCollection` here is a real collection with no publications yet, not a stand-in for absent required work. Retry may carry partial valid members from the same work. A requested brief revision must republish the complete collection, updating each member's version and clearing the whole collection's acceptance. It does not silently carry old accepted members as a completed revision.

## Remaining execution records

These records use the same state, execution, and provenance rules as the implementation workers. A source view derives artifact refs from stored output wrappers; it does not duplicate mutable bodies inside feedback or action intents.

```ts
interface AgentSession<ActionPoint extends string> {
  id: SessionId;
  execution_id: ExecutionId;
  action_point: ActionPoint;
  state: SessionState;
}

interface ReviewResponse<Current> {
  execution_id: ExecutionId;
  current: Current;
}

interface ReviewInterruption<Work, Current> {
  work: Work;
  execution: InterruptedExecution;
  current: Current;
}

interface ReviewWorkerRecord<Work, Outputs, Current, ActionPoint extends string> {
  state: WorkerState;
  active_execution_id: ExecutionId | null;
  work: Work | null;
  outputs: Outputs;
  response: ReviewResponse<Current> | null;
  interrupted: ReviewInterruption<Work, Current> | null;
  sessions: readonly AgentSession<ActionPoint>[];
}

interface SpecStoredOutputs { spec_analysis: SpecAnalysisArtifact | null }
interface PlanStoredOutputs { plan: PlanArtifact | null }
interface BriefStoredMember { cohort_key: CohortKey; artifact: BuildBriefArtifact }
interface BriefStoredOutputs { briefs: readonly BriefStoredMember[] }
interface FinalStoredOutputs { pr_summary: PrSummaryArtifact | null }

type SpecWorkerRecord = ReviewWorkerRecord<SpecWorkInput, SpecStoredOutputs, ArtifactRef | null, "initial" | "revise" | "retry">;
type PlanWorkerRecord = ReviewWorkerRecord<PlanWorkInput, PlanStoredOutputs, ArtifactRef | null, "initial" | "revise" | "retry">;
type BriefWorkerRecord = ReviewWorkerRecord<BriefWorkInput, BriefStoredOutputs, BriefCollection, "initial" | "revise" | "retry">;
interface FinalWorkInput { action_point: "initial"; input: FinalIntegrationInputs }
interface FinalReviewResponse extends ReviewResponse<ArtifactRef | null> {
  head_sha: CommitSha;
}
type FinalWorkerRecord = Omit<ReviewWorkerRecord<FinalWorkInput, FinalStoredOutputs, ArtifactRef | null, "initial" | "retry">, "response"> & {
  response: FinalReviewResponse | null;
};

interface RepositoryRefsArtifact {
  id: ArtifactId;
  type: "dev.repository_refs";
  version: number;
  state: ArtifactState;
  body: RepositoryRefsBody;
  provenance: ArtifactProvenance;
}

interface ProvisionFailure {
  operation: "provision_repository_refs";
  cohort_id: CohortId;
  repository_key: RepositoryKey;
  detail: string;
  kind: "not_a_git_repository" | "missing_integration_branch" | "base_branch_unavailable" | "git_command_failed";
}

type ProvisionOutcome =
  | { kind: "succeeded"; output: ArtifactRef }
  | { kind: "failed"; failure: ProvisionFailure };

interface ProvisionResponse {
  execution_id: ExecutionId;
  outcome: ProvisionOutcome;
}

interface ProvisionExecution {
  execution_id: ExecutionId;
  action_point: "initial" | "retry";
  state: SessionState;
  outcome: ProvisionOutcome | null;
}

interface ProvisionWorkerRecord {
  state: WorkerState;
  active_execution_id: ExecutionId | null;
  outputs: { repository_refs: RepositoryRefsArtifact | null };
  response: ProvisionResponse | null;
  interrupted: { execution: InterruptedExecution } | null;
  executions: readonly ProvisionExecution[];
}

type StageCohortKey = RepositoryKey | CohortKey | "spec_analysis" | "planning" | "brief_writing";

interface CohortRecordBase<Inputs> {
  id: CohortId;
  key: StageCohortKey;
  version: number;
  state: CohortState;
  depends_on: readonly CohortId[];
  inputs: Inputs;
}

interface RepositoryPreparationCohortRecord extends CohortRecordBase<RepositoryPreparationInputs> {
  provision: ProvisionWorkerRecord;
}
interface SpecAnalysisCohortRecord extends CohortRecordBase<SpecAnalysisInputs> {
  spec: SpecWorkerRecord;
}
interface PlanningCohortRecord extends CohortRecordBase<PlanningInputs> {
  plan: PlanWorkerRecord;
}
interface BriefWritingCohortRecord extends CohortRecordBase<BriefWritingInputs> {
  brief: BriefWorkerRecord;
}
interface FinalIntegrationCohortRecord extends CohortRecordBase<FinalIntegrationInputs> {
  final_integration: FinalWorkerRecord;
}

interface V15StageRecords {
  repository_preparation: StageRecord<RepositoryPreparationCohortRecord>;
  spec_analysis: StageRecord<SpecAnalysisCohortRecord>;
  planning: StageRecord<PlanningCohortRecord>;
  brief_writing: StageRecord<BriefWritingCohortRecord>;
  implementation: StageRecord<ImplementationCohortRecord>;
  final_integration: StageRecord<FinalIntegrationCohortRecord>;
}

interface V15RunRecord {
  id: RunId;
  version: number;
  state: RunState;
  definition_version: DefinitionVersion;
  inputs: V15RunInputs;
  stages: V15StageRecords;
}
```

Provision failure kinds mirror the existing provisioning adapter, with trace identity and detail normalized at the boundary. Store the original adapter failure as evidence where its extra fields are useful. Interrupted records are captured by the typed session/operation observation transform; the tree's interrupted-state leaf does not reconstruct original inputs from whichever session happens to be latest.

## Worker outputs and action points

All v15 output declarations use `revision: "update"`. Singleton output declarations contain `type` and `revision`. Only the brief writer publishes multiple artifacts to one output, so its declaration also contains `collection_key: "cohort_id"`. That key names the payload field identifying each member; it does not create cohort instances.

| Cohort | Worker | Outputs | Action points |
| --- | --- | --- | --- |
| Repository preparation | provision | repository_refs: dev.repository_refs | initial, retry; both invoke `provision_repository_refs` |
| Spec analysis | spec | spec_analysis: dev.spec_analysis | initial, revise, retry |
| Planning | plan | plan: dev.plan | initial, revise, retry |
| Brief writing | brief | briefs: dev.build_brief, keyed by cohort_id | initial, revise, retry |
| Implementation | build, assessment | The three outputs in the implementation-cohort definition. | The seven actions already specified. |
| Final integration | final_integration | pr_summary: dev.pr_summary | initial, retry |

The provisioning worker has an operation execution history, not fabricated LLM sessions. Other workers have sessions. An operation action is `{operation: "provision_repository_refs", inputs: ...}`; a prompt action is `{prompt: <path>, inputs: ...}`. Reject declarations with both or neither. No `CapabilityDefinition` is involved.

The full serialized definition supplies every exact input binding. Provisioning initial binds repository and base branch; retry binds its original inputs and interruption. Review-worker initials bind their concrete cohort inputs. Their revisions bind `original ← inputs`, their named current output, and `feedback ← request.feedback`. Their retries bind `work`, `interrupted`, and `current` from that worker's interrupted record. Final initial binds repository and completed cohorts; retry binds original inputs, interruption, and current PR summary.

The source namespace is finite and checked by cohort. `inputs` means that cohort's named input type. `worker.outputs.<name>` yields artifact refs or a keyed brief collection. `worker.interrupted.*` supplies the captured original work and retained publications. `request.feedback` is narrowed by its typed request branch. Bindings do not evaluate arbitrary expressions. A compiler resolves the finite source names and checks their types, availability, and exact payload field coverage.

```ts
type V15BindingSource =
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

interface V15InputBinding {
  from: V15BindingSource;
}

type V15InputBindings<Input> = { [Field in keyof Input]: V15InputBinding };

interface V15PromptAction<Input> {
  prompt: string;
  inputs: V15InputBindings<Input>;
}

interface V15OperationAction<Input> {
  operation: "provision_repository_refs";
  inputs: V15InputBindings<Input>;
}
```

## Trees for analysis planning and briefs

These cohorts share the same behavior while keeping their own worker, outputs, prompts, and tree in their stage definition. The serialized workflow expands each tree; the workflow has no shared tree registry.

```text
If terminal: wait with no request; reject any new request.
Otherwise cancel: fence worker, mark worker/cohort cancelled.
Otherwise abandon: fence worker, mark cohort failed.
Otherwise pending and no request: cohort/worker working; invoke initial.
Otherwise working:
  Worker working:
    No request:
      If outputs ready: fence publication; worker awaiting_review.
      Else if execution interrupted: worker interrupted.
      Else wait.
    Any request: reject.
  Worker awaiting_review:
    Accept: accept exact output target; worker accepted; cohort complete.
    Revise: clear acceptance; worker working; invoke revise.
    No request: wait.
    Any other request: reject.
  Worker interrupted:
    Retry: fence old execution; worker working; invoke retry.
    No request: wait.
    Any other request: reject.
Any other state combination: reject as an invalid state.
```

Request names are `accept_analysis` / `revise_analysis` / `retry_analysis`, `accept_plan` / `revise_plan` / `retry_plan`, and `accept_briefs` / `revise_briefs` / `retry_briefs`, plus cancel/abandon. Accept/revise requests target exact current refs; brief requests target the complete keyed collection. Stale, missing, duplicate, or extra collection members reject the entire review decision without partial acceptance.

```ts
type V15OperatorRequest =
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

type V15OperatorRequestEnvelope = Omit<OperatorRequestEnvelope, "request"> & {
  request: V15OperatorRequest;
};
```

All use `V15OperatorRequestEnvelope`. Worker-specific request variants are valid only in their enclosing cohort.

Readiness facts are `spec_outputs_ready`, `plan_outputs_ready`, and `brief_outputs_ready`. Single outputs require successful coercion and provenance for the current work. Plan readiness additionally requires a nonempty, valid dependency graph and supplied repository assignments. Brief readiness requires exact coverage of the accepted plan and preservation of its assignments, dependency sets, and acceptance criteria. Their interruption facts are `<worker>_execution_interrupted`. Readiness takes precedence over session exit, as for implementation.

## Repository preparation tree

The provisioning action calls the existing typed repository-provisioning adapter. It must preserve its idempotent branch-creation and recovery behavior. A retry rechecks current remote state; it does not recreate or rewind an existing base branch.

```text
If terminal: wait with no request; reject any new request.
Otherwise cancel/abandon: fence operation; cohort cancelled/failed.
Otherwise pending and no request: cohort/provision worker working; invoke initial.
Otherwise provision worker working and no request:
  If operation succeeded and refs output valid:
    fence publication; accept refs; worker accepted; cohort complete.
  Else if operation returned a domain failure:
    fence operation; cohort failed; retain structured failure.
  Else if operation execution was interrupted:
    worker interrupted.
  Else wait.
Otherwise provision worker interrupted:
  retry_provision: fence old operation; worker working; invoke retry.
  no request: wait.
  any other request: reject.
Any other state/request combination: reject.
```

The three facts are `provision_outputs_ready`, `provision_failed`, and `provision_execution_interrupted`. A known domain failure is a failed cohort; lost execution with uncertain completion is interrupted work. Both are values with operation, repository/cohort identity, and detail. The worker does not invent an operator approval gate for repository refs.

## Final integration tree

Final integration opens the final PR; it does not edit implementation or merge the PR. Its expected head branch is the prepared run `base_branch`, and its expected PR base is that repository's `integration_branch`. Its completed cohort inputs contain the exact accepted build and assessment versions associated with the observed cohort merges.

```text
If terminal: wait with no request; reject any new request.
Otherwise cancel/abandon: fence worker; cohort cancelled/failed.
Otherwise pending and no request: cohort/worker working; invoke initial.
Otherwise final worker working and no request:
  If final PR output is valid and verified:
    fence publication; worker awaiting_review.
  Else if execution interrupted: worker interrupted.
  Else wait.
Otherwise final worker interrupted:
  retry_final_integration: fence old execution; worker working; invoke retry.
  no request: wait.
  any other request: reject.
Otherwise final worker awaiting_review:
  confirm_merged targeting exact PR output and head:
    If verified merged into expected base:
      accept PR summary; worker accepted; cohort complete.
    Else reject confirmation.
  closed_without_merge targeting exact PR output and head:
    If verified closed without merge: cohort failed.
    Else reject closure report.
  no request: wait.
  any other request: reject.
Any other state combination: reject.
```

The facts are `final_outputs_ready`, `final_execution_interrupted`, `final_pr_merged_at_reviewed_head`, and `final_pr_closed_unmerged`. A merge observation alone does not complete this cohort: final integration requires the operator's confirmation. Neither the worker nor the interpreter performs a merge. Publication stores the verified pushed head in `FinalReviewResponse.head_sha` alongside the exact summary reference. Review targets and later observations must match that retained head; a missing head is a verification failure. A confirmation must be checked against a current verified observation; operator acceptance of assessment verdicts does not waive PR identity, branch, base, or commit checks.

Retry reuses a matching existing final PR before opening another. V15 has no final implementation-revision or closed-PR replacement route; closure fails the stage and run as in the current flow. A moved or mismatched head cannot be confirmed under an old review target; display the verification failure and allow cancellation/abandonment rather than silently rewriting accepted evidence.

## Shared tree and commit semantics

Use the node shapes in the implementation-cohort contract. Expand the finite worker, request, fact, change, and action unions to the names used by these six concrete cohorts. Check names against the enclosing cohort, not an ambient application registry. `match_worker` can only reference its cohort's declared workers; an action leaf can only launch a declared action point.

```ts
type V15WorkerKey = "provision" | "spec" | "plan" | "brief" | "build" | "assessment" | "final_integration";
type V15RequestKind = V15OperatorRequest["kind"] | "none";
type V15StateCases<State extends string> = { [Value in State]?: V15DecisionTree };

type V15Fact =
  | CohortFact
  | "provision_outputs_ready" | "provision_failed" | "provision_execution_interrupted"
  | "spec_outputs_ready" | "spec_execution_interrupted"
  | "plan_outputs_ready" | "plan_execution_interrupted"
  | "brief_outputs_ready" | "brief_execution_interrupted"
  | "final_outputs_ready" | "final_execution_interrupted"
  | "final_pr_merged_at_reviewed_head" | "final_pr_closed_unmerged";

type V15Change =
  | { kind: "set_cohort_state"; state: CohortState }
  | { kind: "set_worker_state"; worker: V15WorkerKey; state: WorkerState }
  | { kind: "accept_outputs"; worker: V15WorkerKey }
  | { kind: "clear_acceptance"; worker: V15WorkerKey }
  | { kind: "fence_execution"; worker: V15WorkerKey }
  | { kind: "capture_accepted_build" }
  | { kind: "clear_accepted_build" };

type V15WorkerAction =
  | WorkerAction
  | { worker: "provision"; action_point: "initial" | "retry" }
  | { worker: "spec" | "plan" | "brief"; action_point: "initial" | "revise" | "retry" }
  | { worker: "final_integration"; action_point: "initial" | "retry" };

type V15DecisionTree =
  | { kind: "match_cohort"; cases: V15StateCases<CohortState>; otherwise: V15DecisionTree }
  | { kind: "match_worker"; worker: V15WorkerKey; cases: V15StateCases<WorkerState>; otherwise: V15DecisionTree }
  | { kind: "match_request"; cases: V15StateCases<V15RequestKind>; otherwise: V15DecisionTree }
  | { kind: "if"; fact: V15Fact; then: V15DecisionTree; else: V15DecisionTree }
  | { kind: "apply"; changes: readonly V15Change[]; actions: readonly V15WorkerAction[] }
  | { kind: "wait"; reason: string }
  | { kind: "reject"; reason: string };
```

All leaves explicitly declare state changes and worker actions. `accept_outputs`, `clear_acceptance`, and `fence_execution` retain their specified meanings. The implementation-only changes that capture/clear the accepted build are invalid in other cohorts. A review transition closes publication authority while preserving the response. A completed required response is reviewable even when its session subsequently ends. Session exit itself never means accepted.

Artifact acceptance metadata is separate from immutable content. `accept_outputs` marks the targeted current versions accepted. `clear_acceptance` marks directly reviewed feedback targets changes_requested and invalidated dependent outputs unreviewed. A new publication or explicit unchanged assessment response makes its current output unreviewed. The request receipt preserves the feedback and exact target even after a later publication changes the current output reference.

Evaluation reaches one leaf, resolves its inputs from the pre-change snapshot, and returns a `Result`. Commit state changes, resolved execution intents, and the request outcome atomically against the cohort version. Consume requests once. Reload and evaluate automatic progression until waiting or terminal. The stored tree is finite and acyclic; validation rejects contradictory writes, missing inputs, illegal owner references, and invalid post-decision states.

Within that atomic commit, each selected worker action receives one execution ID. Store its resolved inputs and prompt/settings, set the worker's active execution, retain its original initial/revise/discuss/replacement work for retry, and initialize its response set. Retry carries only the valid publications explicitly included in its payload. Allocate the session ID when the agent integration creates the session, recording its link to the execution; a failed dispatch may therefore be interrupted with no session ID. A fence clears publication authority for the affected execution and durably requests its stop. These writes are the fixed meaning of a selected action/fence, not another progression decision made by the dispatcher.

Stage activation additionally reserves a slot under the stage's authoritative version/lock. A reservation and initial cohort decision must commit together. Working and awaiting-merge cohorts hold slots through review and interruption. No new action may dispatch after the owning stage or run is stopped, even if its launch intent predates cancellation. Fencing and cancellation races are rechecked at the IO boundary; repeated stop requests are idempotent.

Each stage becomes complete only when all its frozen cohorts are complete. A failed cohort makes the stage failed; a cancelled cohort makes it cancelled unless a failure also exists, in which case failure takes precedence. Stop and durably cancel unfinished siblings before publishing the terminal stage outcome; do not wait for external processes to exit to revoke their authority. Completed siblings retain their results. Session-stop work continues through recovery.

The run completes when all six stages complete. Failure or cancellation stops the run, cancels its other unfinished stages/cohorts, and prevents downstream activation. Failure takes precedence over cancellation when both are recorded. This propagation reads lifecycle states only. It does not interpret worker outputs, verdicts, or prompts.

## Publication and coercion

The artifact bodies are the named types in the artifact schema. All listed fields are required; absence is represented by declared nulls. Do not silently drop invalid fields or invent required values. Counts and artifact content versions are nonnegative integers and positive integers respectively. Unknown contract fields are rejected. Empty findings/risk arrays are valid; an empty plan's `cohorts` is not. Validate relative paths, branded keys, dependency references, and plan/brief correspondence before output readiness.

```ts
interface PublicationIdentity {
  request_id: RequestId;
  run_id: RunId;
  stage_id: StageId;
  cohort_id: CohortId;
  execution_id: ExecutionId;
  session_id: SessionId | null;
}

type ArtifactPublication =
  | { output: "repository_refs"; body: RepositoryRefsBody; expected: ArtifactRef | null }
  | { output: "spec_analysis"; body: SpecAnalysisBody; expected: ArtifactRef | null }
  | { output: "plan"; body: PlanBody; expected: ArtifactRef | null }
  | { output: "briefs"; member_key: CohortKey; body: BuildBriefBody; expected: ArtifactRef | null }
  | { output: "build_result"; body: BuildResultBody; head_sha: CommitSha; expected: ArtifactRef | null }
  | { output: "pr_summary"; body: PrSummaryBody; head_sha: CommitSha; expected: ArtifactRef | null }
  | { output: "assessment"; body: AssessmentBody; build: AcceptedBuild; expected: ArtifactRef | null };

type WorkerPublication =
  | { kind: "artifact"; identity: PublicationIdentity; publication: ArtifactPublication }
  | {
      kind: "assessment_unchanged";
      identity: PublicationIdentity;
      assessment: ArtifactRef;
      build: AcceptedBuild;
      explanation: string;
    };
```

Worker identity is derived from the authorized execution, not trusted from a free-form body. The output must be declared for that worker. Session identity is required for LLM publications and absent for provisioning operations. `expected` identifies the existing content version being updated, or is null for first publication. Return the assigned artifact ref. The request ID makes duplicate delivery return the same ref without incrementing version twice. Reusing an ID with different content is an error.

Every publication is atomically checked against active execution ownership, output/member identity, expected content version, and pinned input provenance. Invalid or stale requests have no side effects. Server-verified build head and PR observations must agree with supplied provenance. For assessments, the supplied build must equal that execution's pinned accepted build.

An unchanged-assessment response is supported only by discussion or its retry. It identifies the exact assessment content and accepted build supplied to that work, and records a new explanation-bearing response without a new content version. It returns to review and never carries prior acceptance forward. Other workers must publish their required outputs; a successful process exit is not a publication.

No new public endpoint layout is required by this domain contract. Existing HTTP and agent integrations must translate their requests into these named values and enforce the new worker/execution ownership. The generated publication contract exposes exact authorized outputs, member keys, expected refs, body schemas, and unchanged-response instructions to the active worker.

## Complete prompt coverage

All eighteen LLM action points have draft prompt files under [workflow-prompts/dev-flow/v15](../../workflow-config/prompts/dev-flow/v15). The workflow JSON retains their intended `workflow-config/prompts/dev-flow/v15/` destinations. Promote those files during implementation. Provisioning has two operation actions and no prompts.

Prompt rendering has a fixed pipeline: selected prompt text, labeled declared input sections with immutable referenced content, execution/repository contract where applicable, then publication contract. Prompts contain no undeclared placeholder variables. Retry inputs expose original work and the publications still owed. The action input object—not a second prompt matrix—determines what content is rendered.

| Worker | Prompt behaviors |
| --- | --- |
| spec | Analyze brief notes against repository evidence; revise analysis from feedback; recover interrupted analysis. |
| plan | Produce a nonempty repository-bound dependency plan; revise it from feedback; recover interrupted planning. No dependency_order field. |
| brief | Produce one brief per accepted plan cohort; revise the complete collection; recover and publish owed members. |
| build | Implement brief; implement feedback from either source; recover interrupted work; replace closed unmerged PR. |
| assessment | Assess accepted implementation; discuss/reconsider assessment; recover interrupted assessment or discussion. |
| final_integration | Open the final PR; recover and reuse an existing matching PR. |

## Build handoff

The v15 semantics and concrete configuration are specified. Implement the five PR boundaries in order: domain/configuration contracts; evaluator/storage/dispatch; implementation cohort; remaining stages/operator surface; clean cutover and end-to-end verification. No step may introduce a competing progression authority or retain an old-run fallback.

Verification must cover all six trees, both builder feedback sources, unchanged assessment discussion, exact-version acceptance, partial and duplicate publication, stale sessions, dependency order, four-slot review/merge waits, cancellation races, stage failure propagation, unused repositories, empty-plan rejection, operator final merge confirmation, restart, and replay. Use actual storage/agent/PR boundaries where required; a draft-tree simulation alone does not prove runtime durability.
