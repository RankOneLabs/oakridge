# V15 workflow artifact schema

This schema defines the artifacts and implementation worker states used by the [complete v15 workflow contract](oakridge-v15-workflow-schema.md). It replaces the earlier schema proposal. The concrete workflow and cohort definitions supply action bindings, execution records, and decision trees.

Implementation targets TypeScript on Bun first, with a full clean cutover. These contracts do not support legacy definitions or existing v15 run records.

## The cohort

A cohort implements one accepted build brief in its assigned repository. It contains a builder and an assessor. The builder produces a build result and PR summary. The assessor produces an assessment of that implementation. The cohort owns the decisions connecting those workers.

```text
Implementation cohort
  state
  brief: dev.build_brief
  repository: dev.repository_refs
  build
    state
    action_points
    outputs
      build_result: dev.build_result
      pr_summary: dev.pr_summary
    sessions
  assessment
    state
    action_points
    outputs
      assessment: dev.assessment
    sessions
  decision_tree
```

The output declaration names its artifact type. That artifact type defines the payload and output coercion. Stored outputs can be absent until published. Session execution and artifact acceptance are separate from worker state.

Repository context also includes the cohort worktree, canonical branch, expected PR base, and the current PR when one exists. These are the inputs already required by the v15 builder and assessor, not a capability registry.

## Concrete worker and artifact types

These types describe the stored workers and output artifacts. The tables and English tree below establish behavior. The [concrete implementation-cohort draft](oakridge-implementation-cohort-schema.md) adds definition/runtime separation, exact action input bindings, review targets, execution records, and the [serialized definition](oakridge-implementation-cohort-definition.json).

Each worker has one state field; it does not configure an initial-state field, a list of states, or a list of completion states.

```ts
type WorkerState =
  | "pending"
  | "working"
  | "awaiting_review"
  | "accepted"
  | "interrupted"
  | "cancelled";

type CohortState =
  | "pending"
  | "working"
  | "awaiting_merge"
  | "complete"
  | "failed"
  | "cancelled";

type ArtifactState =
  | "unreviewed"
  | "accepted"
  | "changes_requested";

type ArtifactId = string & { readonly artifact_id: unique symbol };
type SessionId = string & { readonly session_id: unique symbol };

interface ArtifactProvenance {
  execution_id: ExecutionId;
  session_id: SessionId | null;
}

interface BuildWorker {
  state: WorkerState;
  outputs: {
    build_result: BuildResultArtifact | null;
    pr_summary: PrSummaryArtifact | null;
  };
  sessions: readonly BuildSession[];
}

interface AssessmentWorker {
  state: WorkerState;
  outputs: {
    assessment: AssessmentArtifact | null;
  };
  sessions: readonly AssessmentSession[];
}

interface BuildResultArtifact {
  id: ArtifactId;
  type: "dev.build_result";
  state: ArtifactState;
  version: number;
  body: BuildResultBody;
  provenance: ArtifactProvenance;
}

interface PrSummaryArtifact {
  id: ArtifactId;
  type: "dev.pr_summary";
  state: ArtifactState;
  version: number;
  body: PrSummaryBody;
  provenance: ArtifactProvenance;
}

interface AssessmentArtifact {
  id: ArtifactId;
  type: "dev.assessment";
  state: ArtifactState;
  version: number;
  body: AssessmentBody;
  provenance: ArtifactProvenance;
}

type SessionState = "running" | "finished" | "interrupted" | "cancelled";

interface BuildSession {
  id: SessionId;
  execution_id: ExecutionId;
  action_point: "initial" | "revise" | "retry" | "replace_pr";
  state: SessionState;
}

interface AssessmentSession {
  id: SessionId;
  execution_id: ExecutionId;
  action_point: "initial" | "discuss" | "retry";
  state: SessionState;
}
```

The existing branch supplies the source payload types for these artifacts. The new contract requires repository keys and includes the PR base branch, matching worker publication requirements.

```ts
interface BuildResultBody {
  repository_key: RepositoryKey;
  summary: string;
  changed_files: readonly string[];
  tests: TestEvidence;
  delegated_session_metadata: DelegatedBuildMetadata | null;
  known_issues: readonly BuildIssue[];
}

interface TestEvidence {
  passed: number;
  failed: number;
  output: string | null;
  summary: string | null;
  cargo_test_output: string | null;
}

interface DelegatedBuildMetadata {
  cohort_id: CohortId | null;
  session_id: SessionId | null;
  branch: string | null;
}

interface BuildIssue {
  description: string;
  severity: "blocking" | "warning" | "info";
}

interface PrSummaryBody {
  repository_key: RepositoryKey;
  pr_url: string;
  branch: string;
  base_branch: string;
  summary: string;
  review_status:
    | "draft" | "ready" | "changes_requested"
    | "approved" | "merged" | "closed" | null;
}

interface AssessmentBody {
  verdict: "pass" | "pass_with_notes" | "fail";
  findings: readonly AssessmentFinding[];
  test_evidence: TestEvidence | null;
  recommended_next_actions: readonly string[];
}

interface AssessmentFinding {
  criterion: string | null;
  status: "met" | "not_met" | "partial" | null;
  evidence: string | null;
  description: string | null;
}
```

All listed fields are required; nullable fields explicitly permit null. A declared artifact type is the coercion target. Invalid publication does not produce a valid output or advance the worker. The full workflow contract specifies strict publication and validation behavior.

## Spec analysis artifact

The spec analyzer publishes one `dev.spec_analysis` artifact. Its payload follows the existing v15 type and initial analysis prompt. Empty findings, requirements, source references, and risk arrays are valid.

```ts
type FindingId = string & { readonly finding_id: unique symbol };
type RequirementId = string & { readonly requirement_id: unique symbol };

interface SpecAnalysisArtifact {
  id: ArtifactId;
  type: "dev.spec_analysis";
  state: ArtifactState;
  version: number;
  body: SpecAnalysisBody;
  provenance: ArtifactProvenance;
}

interface SpecAnalysisBody {
  summary: string;
  source_spec_refs: readonly string[];
  findings: readonly SpecFinding[];
  requirements: readonly SpecRequirement[];
  risks: readonly DevRisk[];
}

interface SpecFinding {
  id: FindingId;
  description: string;
  severity: "blocking" | "warning" | "info";
}

interface SpecRequirement {
  id: RequirementId;
  description: string;
  status: "implementable" | "blocked" | "ambiguous";
}

interface DevRisk {
  description: string;
  mitigation: string;
}
```

## Plan artifact

The plan writer consumes accepted spec analysis and repository references and publishes one `dev.plan` artifact. Each planned cohort names its repository and dependencies. A planned cohort is a description of work, not an executing cohort record.

```ts
type CohortKey = string & { readonly cohort_key: unique symbol };
type RepositoryKey = string & { readonly repository_key: unique symbol };

interface PlanArtifact {
  id: ArtifactId;
  type: "dev.plan";
  state: ArtifactState;
  version: number;
  body: PlanBody;
  provenance: ArtifactProvenance;
}

interface PlanBody {
  summary: string;
  cohorts: readonly PlanCohort[];
  scope: PlanScope;
  acceptance_criteria: readonly string[];
  risks: readonly DevRisk[];
}

interface PlanCohort {
  id: CohortKey;
  repository_key: RepositoryKey;
  title: string;
  scope: string;
  depends_on: readonly CohortKey[];
  description: string | null;
  files_in_scope: readonly string[];
  decisions: readonly string[];
  acceptance_criteria: readonly string[];
}

interface PlanScope {
  in_scope: readonly string[];
  out_of_scope: readonly string[];
}
```

The repository key is required here, matching the v15 planning prompt; the existing TypeScript payload allows null. The new contract tightens this for all repository-bound outputs. Plans contain at least one cohort. Cohort keys must be unique, dependencies must refer to planned cohorts and be acyclic, and repository keys must identify supplied repositories. Paths are repository-relative. `depends_on` is the sole scheduling authority; remove `dependency_order` from the payload and planning prompt.

## Build brief artifact

The brief writer consumes the accepted plan and publishes one `dev.build_brief` artifact for each planned cohort. Its `cohort_id` carries the planned cohort's key. It preserves the repository assignment, dependencies, scope, settled decisions, and acceptance criteria.

```ts
interface BuildBriefArtifact {
  id: ArtifactId;
  type: "dev.build_brief";
  state: ArtifactState;
  version: number;
  body: BuildBriefBody;
  provenance: ArtifactProvenance;
}

interface BuildBriefBody {
  cohort_id: CohortKey;
  repository_key: RepositoryKey;
  title: string;
  depends_on: readonly CohortKey[];
  goal: string;
  files_in_scope: readonly string[];
  decisions_made: readonly BriefDecision[];
  approaches_rejected: readonly RejectedApproach[];
  acceptance_criteria: readonly string[];
  next_action: string;
}

interface BriefDecision {
  decision: string;
  rationale: string;
}

interface RejectedApproach {
  approach: string;
  reason: string;
}
```

Briefs form a collection with exactly one member per planned cohort key. Each brief is still an artifact with its own content version and acceptance state. Current v15 reviews the collection together. The accepted brief becomes the implementation cohort's input; it does not contain runtime workers or sessions.

## Builder action points

An action point corresponds to a prompt. The decision tree constructs its input payload. Different feedback sources can invoke the same action point.

| Action point | Prompt | Inputs | Output artifact types |
| --- | --- | --- | --- |
| initial | Implement this brief and publish the implementation results | Brief, repository and worktree context | dev.build_result, dev.pr_summary |
| revise | Implement this feedback against the current implementation | Brief, repository and worktree context, current build result and PR summary, feedback | dev.build_result, dev.pr_summary |
| retry | Recover interrupted build work and finish publication | Inputs of the interrupted action, existing outputs, interrupted execution context | dev.build_result, dev.pr_summary |
| replace_pr | Replace the closed unmerged PR | Brief, repository and worktree context, current build outputs, closed PR | dev.build_result, dev.pr_summary |

The [build prompt files](../../workflow-config/prompts/dev-flow/v15/build/build) supply initial, retry, replacement, and consolidated revision behavior. Promote them to the configured runtime paths during implementation.

Feedback contains the operator's text and the relevant source artifacts. Build review supplies its review feedback; an implementation-change request from assessment supplies the assessment findings and operator feedback. Both call the builder's revise action point.

## Assessor action points

| Action point | Prompt | Inputs | Output artifact type |
| --- | --- | --- | --- |
| initial | Assess this implementation against its brief | Brief, accepted build result and PR summary, repository and worktree context | dev.assessment |
| discuss | Discuss this feedback and reconsider the current assessment | Original assessment inputs, current assessment, operator feedback | dev.assessment |
| retry | Recover interrupted assessment work | Inputs of the interrupted action, existing assessment if present, interrupted execution context | dev.assessment |

The [assessment prompt files](../../workflow-config/prompts/dev-flow/v15/build/assessment) supply initial, discussion, and retry behavior. Promote them to the configured runtime paths during implementation.

Discussion can update the assessment or leave it unchanged. Either outcome returns it to operator review. Finishing a session alone does not count as an assessment publication or acceptance. An unchanged response identifies the existing assessment version, accepted build, execution, and explanation, retaining content version while returning it to review.

## The cohort decision tree

Evaluate the cohort's stored state when output, operator feedback, session results, or PR observations change.

1. A pending cohort starts the builder's initial action. The cohort and builder become working.
2. While the builder is working, collect its build result and PR summary. Both must belong to the current work and the PR must match the cohort's repository and branches. When both outputs are valid, mark the builder awaiting review.
3. If the operator accepts both build artifacts, mark them accepted and mark the builder accepted. Invoke the assessor's initial action and mark the assessor working.
4. If the operator requests changes to the build, clear acceptance of the affected build outputs and the assessment. Mark the assessor pending. Invoke the builder's revise action with the build-review feedback.
5. When the assessor publishes its assessment, mark the assessor awaiting review.
6. If the operator requests discussion or revision of the assessment, invoke the assessor's discuss action with that assessment and feedback. Keep the builder and its outputs accepted. Return the assessor to awaiting review after its response.
7. If the operator requests implementation changes based on the assessment, clear build and assessment acceptance, mark the assessor pending, and invoke the builder's revise action with the assessment findings and feedback. The changed build goes through build review and fresh assessment.
8. If the operator accepts the assessment, mark the assessment artifact and assessor accepted.
9. When the builder and assessor are accepted, wait for the verified cohort PR to merge into the expected base. Mark the cohort complete after that merge is observed.
10. If the PR closes without merging, wait for replacement or abandonment. Replacement invokes the builder's replace_pr action and clears build and assessment acceptance.
11. If a session ends before its required work is published, mark its worker interrupted. Operator retry invokes that worker's retry action. Published work already awaiting review stays available for review.
12. Abandonment fails the cohort. Cancellation cancels it. Both stop any active sessions.

Assessment discussion and implementation revision are separate operator choices. Requesting changes to the assessment does not send the work to the builder.

The assessment verdict is stored in the assessment artifact. Operator acceptance is authoritative, including for a failing verdict.

## Artifact revision

A revision can update the existing artifact or replace it. V15 selects update: retain artifact identity, increment the content version, preserve history, and clear acceptance. Feedback identifies the content version being discussed. Replacement remains a possible output policy for other definitions.

Changing build content makes its old assessment inapplicable; the cohort's decision tree resets assessment work. Discussing assessment content leaves the accepted implementation intact.

Replacement creates a new artifact identity starting at content version one, supersedes the current output reference, preserves prior history, and clears acceptance. V15 uses update for every output. Neither policy requires the stage coordinator to interpret artifact revisions.

## Stage behavior

The implementation stage holds implementation cohorts and their prerequisites. A cohort waits for its required predecessor cohorts to complete. At most four implementation cohorts are active. Each holds its slot through work, interruption, review, and awaiting merge, releasing it when terminal. The stage completes when its cohorts complete, then the coordinator advances eligible stages.

If a cohort fails or is cancelled, stop the stage and cancel all other unfinished cohorts. Completed cohorts retain their results. Dependent stages do not start. Cancellation uses each cohort's cancellation path to fence active executions and durably request that sessions stop.

The complete workflow contract specifies stage-local definitions, frozen membership, typed cohort materialization, and dependency mapping.

## Build handoff

Use the [complete workflow contract](oakridge-v15-workflow-schema.md), [serialized workflow](oakridge-v15-workflow-definition.json), and [refactor specification](oakridge-workflow-refactor-spec.md) together. The remaining work is implementation and verification of those contracts.
