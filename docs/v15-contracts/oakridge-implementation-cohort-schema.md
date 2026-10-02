# V15 implementation cohort contract

This document makes one implementation cohort concrete: its definition, runtime inputs, worker actions, and serialized decision tree. It extends the [artifact schema](oakridge-workflow-schema.md) and [refactor spec](oakridge-workflow-refactor-spec.md). The implementation target is TypeScript on Bun with a clean cutover.

The tree and bindings below specify the implementation contract; runtime behavior still needs to be built. The [complete workflow contract](oakridge-v15-workflow-schema.md) supplies the other stages and cohort creation. V15 revisions keep artifact identity and increment content version. Operator acceptance decides regardless of assessment verdict. An active implementation cohort holds its stage capacity slot through review and merge. `depends_on` is the sole scheduling authority. Failure or cancellation stops the stage and cancels its unfinished cohorts.

## Behavior in English

A cohort receives an accepted build brief and prepared repository context. Once its prerequisites and stage capacity permit activation, it starts the builder. The builder publishes a build result and PR summary for the same implementation and verified PR head. The operator reviews both together.

Accepting the build starts the assessor against those exact accepted versions and commit. Build-review feedback invokes the builder's revision action. Assessment feedback has two routes: discuss the assessment with the assessor, or implement changes with the builder. Both sources of implementation feedback use the same builder action point and prompt.

Assessment discussion preserves the accepted build. It must produce an updated assessment or an explicit response retaining the existing assessment. Either response requires operator review. Implementation revision invalidates the assessment and requires build review followed by fresh assessment.

After both workers are accepted, the cohort waits for its reviewed PR head to merge into the expected base. An unreviewed head cannot complete the cohort. A closed, unmerged PR can be replaced or the cohort abandoned. Interrupted work can be retried. Cancellation and abandonment fence active sessions and stop further work.

## Definition and execution record

The definition owns prompts, output types, input bindings, and the tree. The execution record owns state, sessions, artifact references, observations, and review decisions. The `state` on a worker is its runtime enum field; the definition does not repeat an initial state or configurable state lists.

```ts
interface ImplementationCohortDefinition {
  workers: {
    build: BuildWorkerDefinition;
    assessment: AssessmentWorkerDefinition;
  };
  decision_tree: DecisionTree;
}

interface BuildWorkerDefinition {
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

interface AssessmentWorkerDefinition {
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

type RevisionPolicy = "update" | "replace";

type CohortId = string & { readonly cohort_id: unique symbol };
type ExecutionId = string & { readonly execution_id: unique symbol };
type RequestId = string & { readonly request_id: unique symbol };
type CommitSha = string & { readonly commit_sha: unique symbol };

interface ArtifactRef {
  id: ArtifactId;
  version: number;
}

interface BuildOutputRefs {
  build_result: ArtifactRef;
  pr_summary: ArtifactRef;
}

interface AcceptedBuild {
  outputs: BuildOutputRefs;
  pr_url: string;
  head_sha: CommitSha;
}

interface RepositoryRefsBody {
  repository_key: RepositoryKey;
  repository_path: string;
  integration_branch: string;
  base_branch: string;
  base_head_sha: CommitSha;
}

interface ImplementationRepository {
  refs: RepositoryRefsBody;
  worktree_path: string;
  worktree_base_sha: CommitSha | null;
  canonical_branch: string;
  expected_pr_base: string;
}

interface ImplementationCohortInputs {
  brief: ArtifactRef;
  repository: ImplementationRepository;
}

interface PreparedImplementationRepository extends ImplementationRepository {
  worktree_base_sha: CommitSha;
}

interface ImplementationCohortRecord {
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
```

Artifact, worker, and session types above refer to the preceding schema. The runtime worker records additionally track their current execution and response, as specified below. Repository refs mirror `oakridge-dbos/src/domain/repository-refs.ts` on `epic/wf-interpreter`; worktree and branch fields come from the prepared cohort context. The expected implementation PR base is the run's `base_branch`, not the final integration target.

`inputs.brief` is pinned to an accepted version. Membership, dependency keys, and concurrency belong to stage scheduling. They are not prompt logic or decisions made by the builder.

All three v15 output declarations use `revision: "update"`. A publication increments the content version of the existing artifact and clears acceptance; historical versions remain readable. A first publication creates the artifact ID. The generic revision toggle may support replacement, but v15 does not select it.

## Requests and review targets

An operator request is a typed input to evaluation. It is not an artifact state change applied before the tree runs. Every request carries an ID and the expected cohort version. Feedback and acceptance target exact artifact versions. Duplicate request IDs return their recorded outcome.

```ts
interface BuildReviewTarget {
  outputs: BuildOutputRefs;
  head_sha: CommitSha;
}

interface AssessmentReviewTarget {
  assessment: ArtifactRef;
  build: AcceptedBuild;
}

type BuildFeedback =
  | { source: "build_review"; text: string; target: BuildReviewTarget }
  | { source: "assessment"; text: string; target: AssessmentReviewTarget };

interface AssessmentFeedback {
  text: string;
  target: AssessmentReviewTarget;
}

type OperatorRequest =
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

interface OperatorRequestEnvelope {
  id: RequestId;
  cohort_id: CohortId;
  expected_version: number;
  request: OperatorRequest;
}
```

Before selecting a leaf, check ownership, exact review targets, and required source content. A stale request returns an error, makes no changes, and launches no session. The request type determines its feedback shape. The tree determines whether that request is legal in the current state and what work it invokes.

## Action inputs and their bindings

Inputs containing artifact references resolve to the referenced immutable content for prompt rendering. Persist the resolved references and selected prompt version with the execution intent. Resetting acceptance in that same decision cannot change the prompt's inputs.

```ts
interface BuildInitialInput {
  brief: ArtifactRef;
  repository: PreparedImplementationRepository;
}

interface BuildReviseInput extends BuildInitialInput {
  current_build: BuildOutputRefs;
  feedback: BuildFeedback;
}

interface BuildReplacePrInput extends BuildInitialInput {
  current_build: BuildOutputRefs;
  closed_pr: VerifiedPrObservation;
}

interface AssessmentInitialInput {
  brief: ArtifactRef;
  repository: PreparedImplementationRepository;
  accepted_build: AcceptedBuild;
}

interface AssessmentDiscussInput extends AssessmentInitialInput {
  current_assessment: ArtifactRef;
  feedback: AssessmentFeedback;
}

type BuildWorkInput =
  | { action_point: "initial"; input: BuildInitialInput }
  | { action_point: "revise"; input: BuildReviseInput }
  | { action_point: "replace_pr"; input: BuildReplacePrInput };

type AssessmentWorkInput =
  | { action_point: "initial"; input: AssessmentInitialInput }
  | { action_point: "discuss"; input: AssessmentDiscussInput };

interface InterruptedExecution {
  execution_id: ExecutionId;
  session_id: SessionId | null;
  detail: string;
}

interface BuildRetryInput {
  work: BuildWorkInput;
  interrupted: InterruptedExecution;
  build_result: ArtifactRef | null;
  pr_summary: ArtifactRef | null;
}

interface AssessmentRetryInput {
  work: AssessmentWorkInput;
  interrupted: InterruptedExecution;
  assessment: ArtifactRef | null;
}

interface BuildResponse {
  execution_id: ExecutionId;
  build_result: ArtifactRef | null;
  pr_summary: ArtifactRef | null;
  head_sha: CommitSha | null;
}

interface BuildInterruptedRecord {
  work: BuildWorkInput;
  execution: InterruptedExecution;
  build_result: ArtifactRef | null;
  pr_summary: ArtifactRef | null;
}

interface AssessmentInterruptedRecord {
  work: AssessmentWorkInput;
  execution: InterruptedExecution;
  assessment: ArtifactRef | null;
}

interface BuildWorkerRecord extends BuildWorker {
  active_execution_id: ExecutionId | null;
  work: BuildWorkInput | null;
  response: BuildResponse | null;
  interrupted: BuildInterruptedRecord | null;
}

interface AssessmentWorkerRecord extends AssessmentWorker {
  active_execution_id: ExecutionId | null;
  work: AssessmentWorkInput | null;
  response: AssessmentResponse | null;
  interrupted: AssessmentInterruptedRecord | null;
}
```

Retry retains the original work input rather than nesting another retry payload after every interruption. It launches a new fenced execution. Any carried publication must belong to that same work and commit; otherwise it remains historical context and does not satisfy completion.

Each action declaration has a prompt path and an `inputs` object with the exact keys of its payload type. A binding is `{ from: <source> }`. Sources below are the complete set required for this cohort; there is no arbitrary expression or adapter callback in a binding. The compiler checks the source type against the destination field and the branch's availability guarantees.

```ts
type BindingSource =
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

interface InputBinding {
  from: BindingSource;
}

type InputBindings<Input> = { [Field in keyof Input]: InputBinding };

interface PromptAction<Input> {
  prompt: string;
  inputs: InputBindings<Input>;
}

type BuildInitialAction = PromptAction<BuildInitialInput>;
type BuildReviseAction = PromptAction<BuildReviseInput>;
type BuildRetryAction = PromptAction<BuildRetryInput>;
type BuildReplacePrAction = PromptAction<BuildReplacePrInput>;
type AssessmentInitialAction = PromptAction<AssessmentInitialInput>;
type AssessmentDiscussAction = PromptAction<AssessmentDiscussInput>;
type AssessmentRetryAction = PromptAction<AssessmentRetryInput>;
```

Bindings read a typed source view of the snapshot. Output sources supply artifact references, not copies of mutable artifact wrappers. `build.outputs` is available as a `BuildOutputRefs` only when both current output references exist. The checked request branch determines whether `request.feedback` is `BuildFeedback` or `AssessmentFeedback`. Reject a definition that binds an unavailable or incompatible source, even if its field name is valid.

| Action point | Prompt path under `workflow-config/prompts/dev-flow/v15/` | Exact input bindings |
| --- | --- | --- |
| build.initial | `build/build/initial_build.md` | `brief ← inputs.brief`; `repository ← inputs.repository` |
| build.revise | `build/build/revise.md` (new consolidated prompt) | `brief ← inputs.brief`; `repository ← inputs.repository`; `current_build ← build.outputs`; `feedback ← request.feedback` |
| build.retry | `build/build/retry_after_lost_attempt.md` | `work ← build.interrupted.work`; `interrupted ← build.interrupted.execution`; `build_result ← build.interrupted.build_result`; `pr_summary ← build.interrupted.pr_summary` |
| build.replace_pr | `build/build/replacement_pr.md` | `brief ← inputs.brief`; `repository ← inputs.repository`; `current_build ← build.outputs`; `closed_pr ← observations.pr` |
| assessment.initial | `build/assessment/initial_assessment.md` | `brief ← inputs.brief`; `repository ← inputs.repository`; `accepted_build ← accepted_build` |
| assessment.discuss | `build/assessment/discuss.md` (new prompt) | `brief ← inputs.brief`; `repository ← inputs.repository`; `accepted_build ← assessment.work.input.accepted_build`; `current_assessment ← assessment.outputs.assessment`; `feedback ← request.feedback` |
| assessment.retry | `build/assessment/retry_after_lost_attempt.md` | `work ← assessment.interrupted.work`; `interrupted ← assessment.interrupted.execution`; `assessment ← assessment.interrupted.assessment` |

For example, the concrete builder revision declaration is:

```json
{
  "prompt": "workflow-config/prompts/dev-flow/v15/build/build/revise.md",
  "inputs": {
    "brief": { "from": "inputs.brief" },
    "repository": { "from": "inputs.repository" },
    "current_build": { "from": "build.outputs" },
    "feedback": { "from": "request.feedback" }
  }
}
```

`BuildReviseAction` means that exact declaration shape, with sources constrained to the types in the table. The other six named action declaration types follow their rows. No payload-schema registry is attached to the workflow.

When feedback comes from assessment, render the referenced assessment's verdict, findings, and recommended actions beside the operator's text. Supply the same builder revision prompt. When feedback concerns the assessment itself, supply the assessor's discussion prompt.

## Responses and verified observations

Outputs identify their execution and current work. Build readiness requires both declared outputs and verification that their repository, canonical branch, PR base, and commit agree. An artifact published during an older execution cannot overwrite a newer execution's result.

```ts
interface VerifiedPrObservation {
  pr_url: string;
  repository_key: RepositoryKey;
  head_branch: string;
  base_branch: string;
  head_sha: CommitSha;
  state: "open" | "closed" | "merged";
}

type AssessmentResponse =
  | { kind: "published"; execution_id: ExecutionId; assessment: ArtifactRef; build: AcceptedBuild }
  | { kind: "unchanged"; execution_id: ExecutionId; assessment: ArtifactRef; build: AcceptedBuild; explanation: string };
```

Only discussion, or retry of that discussion, can retain an assessment. The response must identify the assessment supplied to the discussion and the same accepted build. It records a new response with an explanation, but no new content version. It returns the existing content to review without accepting it. A plain session exit cannot substitute for this response.

PR verification is an IO-boundary check that produces a typed observation. Publication and review establish which commit the artifacts describe. Before assessment, check the current head against the build-review target. Before completion, check the merged head against the accepted build. A moved head produces a visible verification problem and cannot silently reuse old acceptance.

## Serialized tree shape

The tree contains matches, fact checks, leaves with explicit changes/actions, waits, and rejections. Matches select exactly one branch; an `if` selects one side. One evaluation reaches one leaf. There is no callback registry, executable condition string, or independent handler deciding progression.

```ts
type WorkerKey = "build" | "assessment";
type RequestKind = OperatorRequest["kind"] | "none";
type StateCases<State extends string> = { [Value in State]?: DecisionTree };

type DecisionTree =
  | { kind: "match_cohort"; cases: StateCases<CohortState>; otherwise: DecisionTree }
  | { kind: "match_worker"; worker: WorkerKey; cases: StateCases<WorkerState>; otherwise: DecisionTree }
  | { kind: "match_request"; cases: StateCases<RequestKind>; otherwise: DecisionTree }
  | { kind: "if"; fact: CohortFact; then: DecisionTree; else: DecisionTree }
  | { kind: "apply"; changes: readonly CohortChange[]; actions: readonly WorkerAction[] }
  | { kind: "wait"; reason: string }
  | { kind: "reject"; reason: string };

type CohortFact =
  | "build_outputs_ready"
  | "assessment_response_ready"
  | "build_execution_interrupted"
  | "assessment_execution_interrupted"
  | "pr_closed_unmerged"
  | "pr_merged_at_accepted_head";

type CohortChange =
  | { kind: "set_cohort_state"; state: CohortState }
  | { kind: "set_worker_state"; worker: WorkerKey; state: WorkerState }
  | { kind: "accept_outputs"; worker: WorkerKey }
  | { kind: "clear_acceptance"; worker: WorkerKey }
  | { kind: "capture_accepted_build" }
  | { kind: "clear_accepted_build" }
  | { kind: "fence_execution"; worker: WorkerKey };

type WorkerAction =
  | { worker: "build"; action_point: "initial" | "revise" | "retry" | "replace_pr" }
  | { worker: "assessment"; action_point: "initial" | "discuss" | "retry" };
```

Facts are named pure transforms of the authoritative snapshot, current responses, and verified observations. Their contracts are fixed below. They cannot be arbitrary configured function names. Stage advancement does not interpret these facts.

| Fact | True exactly when |
| --- | --- |
| build_outputs_ready | Both outputs satisfy the current build work and verified PR commit contract. Partial or historical outputs do not qualify. |
| assessment_response_ready | The current assessment execution has a valid published or explicit unchanged response bound to the accepted build. |
| build_execution_interrupted | The current build execution ended or was lost before its required response became ready. |
| assessment_execution_interrupted | The current assessment execution ended or was lost before its required response became ready. |
| pr_closed_unmerged | The current verified cohort PR closed without merging. |
| pr_merged_at_accepted_head | The current cohort PR merged into the expected base with the accepted build's head and both workers' evidence remains applicable. |

Assessment verdict is content for the operator to consider, not a condition on acceptance. A valid operator acceptance can accept `pass`, `pass_with_notes`, or `fail`.

## Concrete leaves

The names in this table are document abbreviations for literal `apply` nodes. Expand their changes and actions inline when serializing the tree; they are not a separate registry in the workflow definition. Bind action inputs from the pre-change snapshot.

| Leaf | Changes, in the same atomic decision | Action |
| --- | --- | --- |
| start_build | cohort working; builder working | build.initial |
| review_build | fence builder execution; builder awaiting_review | None |
| accept_build | accept builder outputs; capture accepted build; builder accepted; assessor working | assessment.initial |
| revise_build | fence both executions; clear both workers' acceptance; clear accepted build; cohort working; assessor pending; builder working | build.revise |
| review_assessment | fence assessor execution; assessor awaiting_review | None |
| discuss_assessment | clear assessor acceptance; assessor working | assessment.discuss |
| accept_assessment | accept assessor output; assessor accepted; cohort awaiting_merge | None |
| replace_pr | fence both executions; clear both workers' acceptance; clear accepted build; cohort working; assessor pending; builder working | build.replace_pr |
| interrupt_build | builder interrupted | None |
| interrupt_assessment | assessor interrupted | None |
| retry_build | fence builder execution; builder working | build.retry |
| retry_assessment | fence assessor execution; assessor working | assessment.retry |
| complete | cohort complete | None |
| cancel | fence both executions; both workers cancelled; cohort cancelled | None |
| abandon | fence both executions; cohort failed | None |

For example, both feedback routes select this same leaf:

```json
{
  "kind": "apply",
  "changes": [
    { "kind": "fence_execution", "worker": "build" },
    { "kind": "fence_execution", "worker": "assessment" },
    { "kind": "clear_acceptance", "worker": "build" },
    { "kind": "clear_acceptance", "worker": "assessment" },
    { "kind": "clear_accepted_build" },
    { "kind": "set_cohort_state", "state": "working" },
    { "kind": "set_worker_state", "worker": "assessment", "state": "pending" },
    { "kind": "set_worker_state", "worker": "build", "state": "working" }
  ],
  "actions": [{ "worker": "build", "action_point": "revise" }]
}
```

`accept_outputs` applies only to the exact validated review targets. `capture_accepted_build` freezes those versions and verified commit. `clear_acceptance` preserves content and history but makes it ineligible as accepted work. Launching new work starts a new response set: old output pointers may supply context but cannot make the new execution ready. Retry can explicitly carry the valid publications specified by its input.

Fencing is committed before dispatch and prevents further publication from superseded executions. Moving to review freezes the completed response and closes publication authority; its session can no longer modify the review target. The runtime also requests that the affected sessions stop. Cohort cancellation/failure prevents further work even if an external session takes time to exit; retain its actual session outcome rather than pretending the process already stopped.

## Complete branch structure

The [serialized definition](oakridge-implementation-cohort-definition.json) contains both worker declarations, all seven action points, the selected output policies, and the complete literal JSON tree including every leaf's changes and actions. The following is the tree's indented rendering. `match` blocks include explicit fallbacks. Each `if` has two branches. Leaf names refer to the literal nodes in the preceding table.

```text
match cohort.state
  complete / failed / cancelled:
    match request.kind
      none: wait "cohort is terminal"
      otherwise: reject "cohort is terminal"
  otherwise:
    match request.kind
      cancel: cancel
      abandon: abandon
      otherwise:
        match cohort.state
          pending:
            match request.kind
              none: start_build
              otherwise: reject "cohort has not started"
          working:
            match build.state
              working:
                match request.kind
                  none:
                    if build_outputs_ready:
                      then: review_build
                      else:
                        if build_execution_interrupted:
                          then: interrupt_build
                          else: wait "builder response pending"
                  otherwise: reject "builder is working"
              interrupted:
                match request.kind
                  retry_build: retry_build
                  none: wait "builder retry or abandonment required"
                  otherwise: reject "builder is interrupted"
              awaiting_review:
                match request.kind
                  accept_build: accept_build
                  request_build_changes: revise_build
                  replace_pr:
                    if pr_closed_unmerged:
                      then: replace_pr
                      else: reject "PR is not closed without merge"
                  none: wait "build review required"
                  otherwise: reject "request does not apply to build review"
              accepted:
                match request.kind
                  replace_pr:
                    if pr_closed_unmerged:
                      then: replace_pr
                      else: reject "PR is not closed without merge"
                  otherwise:
                    match assessment.state
                      working:
                        match request.kind
                          none:
                            if assessment_response_ready:
                              then: review_assessment
                              else:
                                if assessment_execution_interrupted:
                                  then: interrupt_assessment
                                  else: wait "assessment response pending"
                          otherwise: reject "assessor is working"
                      interrupted:
                        match request.kind
                          retry_assessment: retry_assessment
                          none: wait "assessor retry or abandonment required"
                          otherwise: reject "assessor is interrupted"
                      awaiting_review:
                        match request.kind
                          accept_assessment: accept_assessment
                          discuss_assessment: discuss_assessment
                          request_implementation_changes: revise_build
                          none: wait "assessment review required"
                          otherwise: reject "request does not apply to assessment review"
                      otherwise: reject "invalid assessor state for accepted builder"
              otherwise: reject "invalid builder state for working cohort"
          awaiting_merge:
            match request.kind
              replace_pr:
                if pr_closed_unmerged:
                  then: replace_pr
                  else: reject "PR is not closed without merge"
              none:
                if pr_merged_at_accepted_head:
                  then: complete
                  else: wait "verified merge or PR replacement required"
              otherwise: reject "request does not apply while awaiting merge"
          otherwise: reject "invalid cohort state"
```

The scheduler only evaluates a pending cohort for activation after its prerequisites and capacity permit starting it. The implementation stage allows four active cohorts. `working` and `awaiting_merge` cohorts consume capacity, including interrupted work and review waits. Pending and terminal cohorts do not. Reserve activation capacity atomically so competing activations cannot exceed the limit. An operator cancellation or abandonment can still be processed for a pending cohort. A blocked cohort is a scheduling observation, not another worker state.

Dependencies come exclusively from `depends_on`; the plan no longer declares `dependency_order`. If a cohort fails or is cancelled, stop the stage and submit cancellation for each other unfinished cohort. Completed cohorts retain their results. Prevent new dispatch as soon as the stage is stopping; persist cancellation/fencing and recoverable stop intents for the unfinished cohorts. Dependent stages do not start. This is mechanical lifecycle propagation, not artifact interpretation by the stage coordinator.

Automatic progression runs to a wait or terminal outcome between external inputs. Commit each selected change and action intent, reload the resulting state, and reevaluate with no operator request. Consume a request once with its committed decision; do not reuse it during automatic reevaluation. This lets acceptance start assessment immediately and lets an already observed valid merge complete after assessment acceptance.

Readiness is checked before interrupted execution status: valid required responses stay reviewable even if their session subsequently exits. Readiness never means acceptance. An invalid state combination is an error, not an implicit repair transition.

## Evaluation and execution contract

Evaluation returns `Result<SelectedDecision, CohortDecisionError>`. The error includes operation, cohort ID, and detail. A wait is a successful result. A reject leaf returns a typed request/state error without mutation.

An apply leaf resolves all action inputs from the checked snapshot and validates the complete proposed result. Reject contradictory writes to the same field, mismatched action/worker state, unavailable artifact references, or missing prompt inputs. Commit changes, the request receipt, and uniquely identified execution intents together against the expected cohort version. A version conflict reloads and reevaluates; it never launches work based on the obsolete snapshot.

The dispatcher executes committed intents. It does not interpret the tree or choose another prompt. A replay reuses the execution identity; an explicit retry creates a new identity. The storage and IO boundaries preserve independent builder and assessor fencing.

```ts
type ResolvedBuildAction =
  | BuildWorkInput
  | { action_point: "retry"; input: BuildRetryInput };

type ResolvedAssessmentAction =
  | AssessmentWorkInput
  | { action_point: "retry"; input: AssessmentRetryInput };

type ResolvedWorkerAction =
  | { worker: "build"; action: ResolvedBuildAction }
  | { worker: "assessment"; action: ResolvedAssessmentAction };

type SelectedDecision =
  | { kind: "wait"; reason: string }
  | {
      kind: "apply";
      expected_version: number;
      changes: readonly CohortChange[];
      actions: readonly ResolvedWorkerAction[];
    };

interface CohortDecisionError {
  kind: "invalid_definition" | "invalid_state" | "invalid_request" | "stale_review" | "unavailable_input";
  operation: "evaluate_cohort";
  cohort_id: CohortId;
  detail: string;
}
```

## New prompt texts

The [complete prompt files](../../workflow-config/prompts/dev-flow/v15) cover every v15 action point. The two new behaviors are reproduced below. Render each declared input as a labeled section with referenced artifact content, then append the authoritative repository and publication contracts. The supplied prompt files avoid undeclared placeholder variables.

### Builder revision

```text
Implement the supplied feedback against the current implementation of this build brief.

Read the brief, repository context, current build outputs, and feedback supplied below. The feedback includes the operator's text and its reviewed source artifacts. When the source is an assessment, use its findings and recommended actions to understand the implementation changes requested. Feedback origin does not change your responsibility: revise the implementation.

Keep the brief's scope and the supplied repository and branch roles. If feedback conflicts with the brief or cannot be implemented within that scope, report the conflict explicitly in the build result rather than silently broadening the work.

Make focused changes, run relevant tests and typecheck, push the canonical cohort ref, and update the cohort PR against the stated base. Publish both a build result and PR summary describing the revised implementation and current commit through the appended publication contract. Report changed files, test evidence, and remaining issues.

Do not publish an assessment, merge the PR, or mark your work accepted. Finish after both required outputs have been published successfully.
```

### Assessment discussion

```text
Discuss the operator's feedback and reconsider the supplied assessment of this accepted implementation.

Read the build brief, accepted build outputs and commit, current assessment, and operator feedback supplied below. Address the feedback directly. Recheck the evidence needed to resolve disputed findings. You may correct findings, revise the verdict, or explain why the existing assessment remains appropriate.

Assess the same accepted implementation. Do not implement fixes, change repository content, push commits, or revise the build artifacts. If resolving a concern requires implementation work, describe that work for the operator to route to the builder.

If assessment content changes, publish the revised assessment through the appended publication contract. If it remains unchanged, submit an explicit unchanged response identifying the supplied assessment version and accepted build, with an explanation addressing the feedback. Either outcome returns to operator review; it does not accept the assessment.

Finish only after the revised publication or unchanged response succeeds.
```

## Full workflow

The [complete workflow contract](oakridge-v15-workflow-schema.md) specifies cohort creation, capacity, dependencies, failure propagation, all six trees, and publication contracts. The [serialized workflow](oakridge-v15-workflow-definition.json) embeds this cohort alongside the other five stages. Build and verify that configuration without retaining an old progression path.
