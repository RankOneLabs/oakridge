/** Replaces the retired event-row matrix with every authored implementation leaf. */
import { expect, test } from "bun:test";
import { evaluateCohort } from "../src/decision/stage-machine";
import type { ArtifactRef, ImplementationCohortDefinition, ImplementationCohortRecord, OperatorRequest,
  WorkerState, CohortState, VerifiedPrObservation, ResolvedWorkerAction, CohortChange, V15DecisionTree } from "../src/domain/dev-flow-v15";

const definition = (await Bun.file(new URL("../../workflow-config/definitions/dev_flow_v15.json", import.meta.url)).json())
  .stages.implementation.cohort as ImplementationCohortDefinition;
const brief = { id: "00000000-0000-4000-8000-000000000001", version: 1 } as ArtifactRef;
const outputs = { build_result: { ...brief, id: "00000000-0000-4000-8000-000000000002" as ArtifactRef["id"] },
  pr_summary: { ...brief, id: "00000000-0000-4000-8000-000000000003" as ArtifactRef["id"] } };
const assessmentRef = { ...brief, id: "00000000-0000-4000-8000-000000000004" as ArtifactRef["id"] };
const repository = { refs: { repository_key: "oakridge" as never, repository_path: "/repo",
  integration_branch: "epic/wf", base_branch: "epic/schema", base_head_sha: "abc" as never },
  worktree_path: "/repo/worktree", worktree_base_sha: "abc" as never,
  canonical_branch: "cohort/core", expected_pr_base: "epic/schema" };
const buildTarget = { outputs, head_sha: "abc" as never };
const accepted = { ...buildTarget, pr_url: "https://example.test/pr/1" };
const assessmentTarget = { assessment: assessmentRef, build: accepted };
const buildWork = { action_point: "initial" as const, input: { brief, repository } };
const assessmentWork = { action_point: "initial" as const, input: { brief, repository, accepted_build: accepted } };
const buildInterruption = { work: buildWork, execution: { execution_id: "build-execution" as never,
  session_id: null, detail: "transport lost" }, ...outputs };
const assessmentInterruption = { work: assessmentWork, execution: { execution_id: "assessment-execution" as never,
  session_id: null, detail: "transport lost" }, assessment: assessmentRef };
const buildFeedback = { source: "build_review" as const, text: "revise", target: buildTarget };
const assessmentFeedback = { source: "assessment" as const, text: "revise", target: assessmentTarget };
const requests: Readonly<Record<string, OperatorRequest | null>> = {
  none: null, retry_build: { kind: "retry_build" }, retry_assessment: { kind: "retry_assessment" },
  accept_build: { kind: "accept_build", target: buildTarget },
  accept_assessment: { kind: "accept_assessment", target: assessmentTarget },
  request_build_changes: { kind: "request_build_changes", feedback: buildFeedback },
  discuss_assessment: { kind: "discuss_assessment", feedback: assessmentFeedback },
  request_implementation_changes: { kind: "request_implementation_changes", feedback: assessmentFeedback },
  replace_pr: { kind: "replace_pr", target: buildTarget }, cancel: { kind: "cancel" },
  abandon: { kind: "abandon", reason: "stop" },
};
interface LeafCase {
  readonly name: string;
  readonly state: string;
  readonly build: string;
  readonly assessment: string;
  readonly request: string;
  readonly facts: { readonly build_outputs_ready?: boolean; readonly build_execution_interrupted?: boolean;
    readonly assessment_response_ready?: boolean; readonly assessment_execution_interrupted?: boolean;
    readonly pr_closed_unmerged?: boolean; readonly pr_merged_at_accepted_head?: boolean };
  readonly expected: { readonly kind: "wait"; readonly reason: string }
    | { readonly kind: "reject"; readonly reason: string }
    | { readonly kind: "apply"; readonly changes: readonly CohortChange[];
        readonly actions: readonly { readonly worker: "build" | "assessment"; readonly action_point: string }[] };
}
// Concrete cases derived once from the committed contract, not from the implementation under test.
const cases: readonly LeafCase[] = [
  {"name":"match_cohort=complete / match_request=none","state":"complete","build":"pending","assessment":"pending","request":"none","facts":{},"expected":{"kind":"wait","reason":"cohort is terminal"}},
  {"name":"match_cohort=complete / match_request=otherwise","state":"complete","build":"pending","assessment":"pending","request":"retry_build","facts":{},"expected":{"kind":"reject","reason":"cohort is terminal"}},
  {"name":"match_cohort=failed / match_request=none","state":"failed","build":"pending","assessment":"pending","request":"none","facts":{},"expected":{"kind":"wait","reason":"cohort is terminal"}},
  {"name":"match_cohort=failed / match_request=otherwise","state":"failed","build":"pending","assessment":"pending","request":"retry_build","facts":{},"expected":{"kind":"reject","reason":"cohort is terminal"}},
  {"name":"match_cohort=cancelled / match_request=none","state":"cancelled","build":"pending","assessment":"pending","request":"none","facts":{},"expected":{"kind":"wait","reason":"cohort is terminal"}},
  {"name":"match_cohort=cancelled / match_request=otherwise","state":"cancelled","build":"pending","assessment":"pending","request":"retry_build","facts":{},"expected":{"kind":"reject","reason":"cohort is terminal"}},
  {"name":"match_cohort=otherwise / match_request=cancel","state":"pending","build":"pending","assessment":"pending","request":"cancel","facts":{},"expected":{"kind":"apply","changes":[{"kind":"fence_execution","worker":"build"},{"kind":"fence_execution","worker":"assessment"},{"kind":"set_worker_state","worker":"build","state":"cancelled"},{"kind":"set_worker_state","worker":"assessment","state":"cancelled"},{"kind":"set_cohort_state","state":"cancelled"}],"actions":[]}},
  {"name":"match_cohort=otherwise / match_request=abandon","state":"pending","build":"pending","assessment":"pending","request":"abandon","facts":{},"expected":{"kind":"apply","changes":[{"kind":"fence_execution","worker":"build"},{"kind":"fence_execution","worker":"assessment"},{"kind":"set_cohort_state","state":"failed"}],"actions":[]}},
  {"name":"match_cohort=otherwise / match_request=otherwise / match_cohort=pending / match_request=none","state":"pending","build":"pending","assessment":"pending","request":"none","facts":{},"expected":{"kind":"apply","changes":[{"kind":"set_cohort_state","state":"working"},{"kind":"set_worker_state","worker":"build","state":"working"}],"actions":[{"worker":"build","action_point":"initial"}]}},
  {"name":"match_cohort=otherwise / match_request=otherwise / match_cohort=pending / match_request=otherwise","state":"pending","build":"pending","assessment":"pending","request":"retry_build","facts":{},"expected":{"kind":"reject","reason":"cohort has not started"}},
  {"name":"match_cohort=otherwise / match_request=otherwise / match_cohort=working / match_worker:build=working / match_request=none / build_outputs_ready=true","state":"working","build":"working","assessment":"pending","request":"none","facts":{"build_outputs_ready":true},"expected":{"kind":"apply","changes":[{"kind":"fence_execution","worker":"build"},{"kind":"set_worker_state","worker":"build","state":"awaiting_review"}],"actions":[]}},
  {"name":"match_cohort=otherwise / match_request=otherwise / match_cohort=working / match_worker:build=working / match_request=none / build_outputs_ready=false / build_execution_interrupted=true","state":"working","build":"working","assessment":"pending","request":"none","facts":{"build_outputs_ready":false,"build_execution_interrupted":true},"expected":{"kind":"apply","changes":[{"kind":"set_worker_state","worker":"build","state":"interrupted"}],"actions":[]}},
  {"name":"match_cohort=otherwise / match_request=otherwise / match_cohort=working / match_worker:build=working / match_request=none / build_outputs_ready=false / build_execution_interrupted=false","state":"working","build":"working","assessment":"pending","request":"none","facts":{"build_outputs_ready":false,"build_execution_interrupted":false},"expected":{"kind":"wait","reason":"builder response pending"}},
  {"name":"match_cohort=otherwise / match_request=otherwise / match_cohort=working / match_worker:build=working / match_request=otherwise","state":"working","build":"working","assessment":"pending","request":"retry_build","facts":{},"expected":{"kind":"reject","reason":"builder is working"}},
  {"name":"match_cohort=otherwise / match_request=otherwise / match_cohort=working / match_worker:build=interrupted / match_request=retry_build","state":"working","build":"interrupted","assessment":"pending","request":"retry_build","facts":{},"expected":{"kind":"apply","changes":[{"kind":"fence_execution","worker":"build"},{"kind":"set_worker_state","worker":"build","state":"working"}],"actions":[{"worker":"build","action_point":"retry"}]}},
  {"name":"match_cohort=otherwise / match_request=otherwise / match_cohort=working / match_worker:build=interrupted / match_request=none","state":"working","build":"interrupted","assessment":"pending","request":"none","facts":{},"expected":{"kind":"wait","reason":"builder retry or abandonment required"}},
  {"name":"match_cohort=otherwise / match_request=otherwise / match_cohort=working / match_worker:build=interrupted / match_request=otherwise","state":"working","build":"interrupted","assessment":"pending","request":"retry_assessment","facts":{},"expected":{"kind":"reject","reason":"builder is interrupted"}},
  {"name":"match_cohort=otherwise / match_request=otherwise / match_cohort=working / match_worker:build=awaiting_review / match_request=accept_build","state":"working","build":"awaiting_review","assessment":"pending","request":"accept_build","facts":{},"expected":{"kind":"apply","changes":[{"kind":"accept_outputs","worker":"build"},{"kind":"capture_accepted_build"},{"kind":"set_worker_state","worker":"build","state":"accepted"},{"kind":"set_worker_state","worker":"assessment","state":"working"}],"actions":[{"worker":"assessment","action_point":"initial"}]}},
  {"name":"match_cohort=otherwise / match_request=otherwise / match_cohort=working / match_worker:build=awaiting_review / match_request=request_build_changes","state":"working","build":"awaiting_review","assessment":"pending","request":"request_build_changes","facts":{},"expected":{"kind":"apply","changes":[{"kind":"fence_execution","worker":"build"},{"kind":"fence_execution","worker":"assessment"},{"kind":"clear_acceptance","worker":"build"},{"kind":"clear_acceptance","worker":"assessment"},{"kind":"clear_accepted_build"},{"kind":"set_cohort_state","state":"working"},{"kind":"set_worker_state","worker":"assessment","state":"pending"},{"kind":"set_worker_state","worker":"build","state":"working"}],"actions":[{"worker":"build","action_point":"revise"}]}},
  {"name":"match_cohort=otherwise / match_request=otherwise / match_cohort=working / match_worker:build=awaiting_review / match_request=replace_pr / pr_closed_unmerged=true","state":"working","build":"awaiting_review","assessment":"pending","request":"replace_pr","facts":{"pr_closed_unmerged":true},"expected":{"kind":"apply","changes":[{"kind":"fence_execution","worker":"build"},{"kind":"fence_execution","worker":"assessment"},{"kind":"clear_acceptance","worker":"build"},{"kind":"clear_acceptance","worker":"assessment"},{"kind":"clear_accepted_build"},{"kind":"set_cohort_state","state":"working"},{"kind":"set_worker_state","worker":"assessment","state":"pending"},{"kind":"set_worker_state","worker":"build","state":"working"}],"actions":[{"worker":"build","action_point":"replace_pr"}]}},
  {"name":"match_cohort=otherwise / match_request=otherwise / match_cohort=working / match_worker:build=awaiting_review / match_request=replace_pr / pr_closed_unmerged=false","state":"working","build":"awaiting_review","assessment":"pending","request":"replace_pr","facts":{"pr_closed_unmerged":false},"expected":{"kind":"reject","reason":"PR is not closed without merge"}},
  {"name":"match_cohort=otherwise / match_request=otherwise / match_cohort=working / match_worker:build=awaiting_review / match_request=none","state":"working","build":"awaiting_review","assessment":"pending","request":"none","facts":{},"expected":{"kind":"wait","reason":"build review required"}},
  {"name":"match_cohort=otherwise / match_request=otherwise / match_cohort=working / match_worker:build=awaiting_review / match_request=otherwise","state":"working","build":"awaiting_review","assessment":"pending","request":"retry_build","facts":{},"expected":{"kind":"reject","reason":"request does not apply to build review"}},
  {"name":"match_cohort=otherwise / match_request=otherwise / match_cohort=working / match_worker:build=accepted / match_request=replace_pr / pr_closed_unmerged=true","state":"working","build":"accepted","assessment":"pending","request":"replace_pr","facts":{"pr_closed_unmerged":true},"expected":{"kind":"apply","changes":[{"kind":"fence_execution","worker":"build"},{"kind":"fence_execution","worker":"assessment"},{"kind":"clear_acceptance","worker":"build"},{"kind":"clear_acceptance","worker":"assessment"},{"kind":"clear_accepted_build"},{"kind":"set_cohort_state","state":"working"},{"kind":"set_worker_state","worker":"assessment","state":"pending"},{"kind":"set_worker_state","worker":"build","state":"working"}],"actions":[{"worker":"build","action_point":"replace_pr"}]}},
  {"name":"match_cohort=otherwise / match_request=otherwise / match_cohort=working / match_worker:build=accepted / match_request=replace_pr / pr_closed_unmerged=false","state":"working","build":"accepted","assessment":"pending","request":"replace_pr","facts":{"pr_closed_unmerged":false},"expected":{"kind":"reject","reason":"PR is not closed without merge"}},
  {"name":"match_cohort=otherwise / match_request=otherwise / match_cohort=working / match_worker:build=accepted / match_request=otherwise / match_worker:assessment=working / match_request=none / assessment_response_ready=true","state":"working","build":"accepted","assessment":"working","request":"none","facts":{"assessment_response_ready":true},"expected":{"kind":"apply","changes":[{"kind":"fence_execution","worker":"assessment"},{"kind":"set_worker_state","worker":"assessment","state":"awaiting_review"}],"actions":[]}},
  {"name":"match_cohort=otherwise / match_request=otherwise / match_cohort=working / match_worker:build=accepted / match_request=otherwise / match_worker:assessment=working / match_request=none / assessment_response_ready=false / assessment_execution_interrupted=true","state":"working","build":"accepted","assessment":"working","request":"none","facts":{"assessment_response_ready":false,"assessment_execution_interrupted":true},"expected":{"kind":"apply","changes":[{"kind":"set_worker_state","worker":"assessment","state":"interrupted"}],"actions":[]}},
  {"name":"match_cohort=otherwise / match_request=otherwise / match_cohort=working / match_worker:build=accepted / match_request=otherwise / match_worker:assessment=working / match_request=none / assessment_response_ready=false / assessment_execution_interrupted=false","state":"working","build":"accepted","assessment":"working","request":"none","facts":{"assessment_response_ready":false,"assessment_execution_interrupted":false},"expected":{"kind":"wait","reason":"assessment response pending"}},
  {"name":"match_cohort=otherwise / match_request=otherwise / match_cohort=working / match_worker:build=accepted / match_request=otherwise / match_worker:assessment=working / match_request=otherwise","state":"working","build":"accepted","assessment":"working","request":"retry_build","facts":{},"expected":{"kind":"reject","reason":"assessor is working"}},
  {"name":"match_cohort=otherwise / match_request=otherwise / match_cohort=working / match_worker:build=accepted / match_request=otherwise / match_worker:assessment=interrupted / match_request=retry_assessment","state":"working","build":"accepted","assessment":"interrupted","request":"retry_assessment","facts":{},"expected":{"kind":"apply","changes":[{"kind":"fence_execution","worker":"assessment"},{"kind":"set_worker_state","worker":"assessment","state":"working"}],"actions":[{"worker":"assessment","action_point":"retry"}]}},
  {"name":"match_cohort=otherwise / match_request=otherwise / match_cohort=working / match_worker:build=accepted / match_request=otherwise / match_worker:assessment=interrupted / match_request=none","state":"working","build":"accepted","assessment":"interrupted","request":"none","facts":{},"expected":{"kind":"wait","reason":"assessor retry or abandonment required"}},
  {"name":"match_cohort=otherwise / match_request=otherwise / match_cohort=working / match_worker:build=accepted / match_request=otherwise / match_worker:assessment=interrupted / match_request=otherwise","state":"working","build":"accepted","assessment":"interrupted","request":"retry_build","facts":{},"expected":{"kind":"reject","reason":"assessor is interrupted"}},
  {"name":"match_cohort=otherwise / match_request=otherwise / match_cohort=working / match_worker:build=accepted / match_request=otherwise / match_worker:assessment=awaiting_review / match_request=accept_assessment","state":"working","build":"accepted","assessment":"awaiting_review","request":"accept_assessment","facts":{},"expected":{"kind":"apply","changes":[{"kind":"accept_outputs","worker":"assessment"},{"kind":"set_worker_state","worker":"assessment","state":"accepted"},{"kind":"set_cohort_state","state":"awaiting_merge"}],"actions":[]}},
  {"name":"match_cohort=otherwise / match_request=otherwise / match_cohort=working / match_worker:build=accepted / match_request=otherwise / match_worker:assessment=awaiting_review / match_request=discuss_assessment","state":"working","build":"accepted","assessment":"awaiting_review","request":"discuss_assessment","facts":{},"expected":{"kind":"apply","changes":[{"kind":"clear_acceptance","worker":"assessment"},{"kind":"set_worker_state","worker":"assessment","state":"working"}],"actions":[{"worker":"assessment","action_point":"discuss"}]}},
  {"name":"match_cohort=otherwise / match_request=otherwise / match_cohort=working / match_worker:build=accepted / match_request=otherwise / match_worker:assessment=awaiting_review / match_request=request_implementation_changes","state":"working","build":"accepted","assessment":"awaiting_review","request":"request_implementation_changes","facts":{},"expected":{"kind":"apply","changes":[{"kind":"fence_execution","worker":"build"},{"kind":"fence_execution","worker":"assessment"},{"kind":"clear_acceptance","worker":"build"},{"kind":"clear_acceptance","worker":"assessment"},{"kind":"clear_accepted_build"},{"kind":"set_cohort_state","state":"working"},{"kind":"set_worker_state","worker":"assessment","state":"pending"},{"kind":"set_worker_state","worker":"build","state":"working"}],"actions":[{"worker":"build","action_point":"revise"}]}},
  {"name":"match_cohort=otherwise / match_request=otherwise / match_cohort=working / match_worker:build=accepted / match_request=otherwise / match_worker:assessment=awaiting_review / match_request=none","state":"working","build":"accepted","assessment":"awaiting_review","request":"none","facts":{},"expected":{"kind":"wait","reason":"assessment review required"}},
  {"name":"match_cohort=otherwise / match_request=otherwise / match_cohort=working / match_worker:build=accepted / match_request=otherwise / match_worker:assessment=awaiting_review / match_request=otherwise","state":"working","build":"accepted","assessment":"awaiting_review","request":"retry_build","facts":{},"expected":{"kind":"reject","reason":"request does not apply to assessment review"}},
  {"name":"match_cohort=otherwise / match_request=otherwise / match_cohort=working / match_worker:build=accepted / match_request=otherwise / match_worker:assessment=otherwise","state":"working","build":"accepted","assessment":"pending","request":"none","facts":{},"expected":{"kind":"reject","reason":"invalid assessor state for accepted builder"}},
  {"name":"match_cohort=otherwise / match_request=otherwise / match_cohort=working / match_worker:build=otherwise","state":"working","build":"pending","assessment":"pending","request":"none","facts":{},"expected":{"kind":"reject","reason":"invalid builder state for working cohort"}},
  {"name":"match_cohort=otherwise / match_request=otherwise / match_cohort=awaiting_merge / match_request=replace_pr / pr_closed_unmerged=true","state":"awaiting_merge","build":"accepted","assessment":"accepted","request":"replace_pr","facts":{"pr_closed_unmerged":true},"expected":{"kind":"apply","changes":[{"kind":"fence_execution","worker":"build"},{"kind":"fence_execution","worker":"assessment"},{"kind":"clear_acceptance","worker":"build"},{"kind":"clear_acceptance","worker":"assessment"},{"kind":"clear_accepted_build"},{"kind":"set_cohort_state","state":"working"},{"kind":"set_worker_state","worker":"assessment","state":"pending"},{"kind":"set_worker_state","worker":"build","state":"working"}],"actions":[{"worker":"build","action_point":"replace_pr"}]}},
  {"name":"match_cohort=otherwise / match_request=otherwise / match_cohort=awaiting_merge / match_request=replace_pr / pr_closed_unmerged=false","state":"awaiting_merge","build":"accepted","assessment":"accepted","request":"replace_pr","facts":{"pr_closed_unmerged":false},"expected":{"kind":"reject","reason":"PR is not closed without merge"}},
  {"name":"match_cohort=otherwise / match_request=otherwise / match_cohort=awaiting_merge / match_request=none / pr_merged_at_accepted_head=true","state":"awaiting_merge","build":"accepted","assessment":"accepted","request":"none","facts":{"pr_merged_at_accepted_head":true},"expected":{"kind":"apply","changes":[{"kind":"set_cohort_state","state":"complete"}],"actions":[]}},
  {"name":"match_cohort=otherwise / match_request=otherwise / match_cohort=awaiting_merge / match_request=none / pr_merged_at_accepted_head=false","state":"awaiting_merge","build":"accepted","assessment":"accepted","request":"none","facts":{"pr_merged_at_accepted_head":false},"expected":{"kind":"wait","reason":"verified merge or PR replacement required"}},
  {"name":"match_cohort=otherwise / match_request=otherwise / match_cohort=awaiting_merge / match_request=otherwise","state":"awaiting_merge","build":"accepted","assessment":"accepted","request":"retry_build","facts":{},"expected":{"kind":"reject","reason":"request does not apply while awaiting merge"}},
  {"name":"match_cohort=otherwise / match_request=otherwise / match_cohort=otherwise","state":"invalid","build":"pending","assessment":"pending","request":"none","facts":{},"expected":{"kind":"reject","reason":"invalid cohort state"}}
];

const snapshotFor = (item: LeafCase): ImplementationCohortRecord => ({
  id: "00000000-0000-4000-8000-000000000010" as never, key: "core" as never, version: 7,
  state: item.state as CohortState, depends_on: [], inputs: { brief, repository },
  build: { state: item.build as WorkerState, active_execution_id: "build-execution" as never,
    outputs: { build_result: { ...outputs.build_result, type: "dev.build_result", state: "unreviewed", body: {} as never,
      provenance: { execution_id: "build-execution" as never, session_id: null } },
      pr_summary: { ...outputs.pr_summary, type: "dev.pr_summary", state: "unreviewed", body: { pr_url: accepted.pr_url } as never,
        provenance: { execution_id: "build-execution" as never, session_id: null } } },
    sessions: [], work: buildWork,
    response: (item.facts.build_outputs_ready ?? ["awaiting_review", "accepted"].includes(item.build)) ? { execution_id: "build-execution" as never, ...outputs, head_sha: buildTarget.head_sha } : null,
    interrupted: item.facts.build_execution_interrupted || item.build === "interrupted" ? buildInterruption : null },
  assessment: { state: item.assessment as WorkerState, active_execution_id: "assessment-execution" as never,
    outputs: { assessment: { ...assessmentRef, type: "dev.assessment", state: "unreviewed", body: {} as never,
      provenance: { execution_id: "assessment-execution" as never, session_id: null } } },
    sessions: [], work: assessmentWork,
    response: item.facts.assessment_response_ready ? { kind: "published", execution_id: "assessment-execution" as never,
      assessment: assessmentRef, build: accepted } : null,
    interrupted: item.facts.assessment_execution_interrupted || item.assessment === "interrupted" ? assessmentInterruption : null },
  accepted_build: item.build === "accepted" ? accepted : null,
});
const prFor = (item: LeafCase): VerifiedPrObservation => ({
  pr_url: accepted.pr_url, repository_key: repository.refs.repository_key,
  head_branch: repository.canonical_branch, base_branch: repository.expected_pr_base,
  head_sha: "abc" as never, state: item.facts.pr_closed_unmerged ? "closed" : item.facts.pr_merged_at_accepted_head ? "merged" : "open",
});
const expectedAction = (worker: string, action_point: string, request: OperatorRequest | null,
  pr: VerifiedPrObservation): ResolvedWorkerAction => {
  if (worker === "build") {
    if (action_point === "initial") return { worker, action: buildWork };
    if (action_point === "retry") return { worker, action: { action_point, input: {
      work: buildWork, interrupted: buildInterruption.execution, ...outputs } } };
    if (action_point === "replace_pr") return { worker, action: { action_point, input: {
      brief, repository, current_build: outputs, closed_pr: pr } } };
    return { worker, action: { action_point: "revise", input: { brief, repository, current_build: outputs,
      feedback: request && "feedback" in request ? request.feedback as typeof buildFeedback : buildFeedback } } };
  }
  if (action_point === "initial") return { worker: "assessment", action: assessmentWork };
  if (action_point === "retry") return { worker: "assessment", action: { action_point, input: {
    work: assessmentWork, interrupted: assessmentInterruption.execution, assessment: assessmentRef } } };
  return { worker: "assessment", action: { action_point: "discuss", input: {
    brief, repository, accepted_build: accepted, current_assessment: assessmentRef, feedback: assessmentFeedback } } };
};
for (const item of cases) test(`implementation leaf: ${item.name}`, () => {
  const request = requests[item.request] ?? null;
  const pr = prFor(item);
  const result = evaluateCohort({ definition, snapshot: snapshotFor(item), request, pr,
    available_artifacts: [brief, outputs.build_result, outputs.pr_summary, assessmentRef] });
  if (item.expected.kind === "reject") expect(result).toEqual({ ok: false, error: {
    kind: request ? "invalid_request" : "invalid_state", operation: "evaluate_cohort",
    cohort_id: snapshotFor(item).id, detail: item.expected.reason,
  } });
  else if (item.expected.kind === "wait") expect(result).toEqual({ ok: true, value: { kind: "wait", reason: item.expected.reason } });
  else expect(result).toEqual({ ok: true, value: { kind: "apply", expected_version: 7,
    changes: item.expected.changes, actions: item.expected.actions.map((action) => expectedAction(action.worker, action.action_point, request, pr)),
  } });
});
const authoredLeafPaths = (node: V15DecisionTree, path: readonly string[] = []): readonly string[] => {
  if (node.kind === "apply" || node.kind === "wait" || node.kind === "reject") return [path.join(" / ")];
  if (node.kind === "if") return [
    ...authoredLeafPaths(node.then, [...path, `${node.fact}=true`]),
    ...authoredLeafPaths(node.else, [...path, `${node.fact}=false`]),
  ];
  const label = node.kind === "match_worker" ? `${node.kind}:${node.worker}` : node.kind;
  return [...Object.entries(node.cases).flatMap(([key, child]) => authoredLeafPaths(child, [...path, `${label}=${key}`])),
    ...authoredLeafPaths(node.otherwise, [...path, `${label}=otherwise`])];
};
test("the implementation matrix covers each authored leaf exactly once", () => {
  expect(cases.map((item) => item.name).sort()).toEqual([...authoredLeafPaths(definition.decision_tree)].sort());
});
