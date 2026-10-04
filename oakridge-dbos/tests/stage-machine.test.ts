import { expect, test } from "bun:test";
import { evaluateCohort, evaluateV15Cohort, evaluateV15Fact } from "../src/decision/stage-machine";
import type { ImplementationCohortDefinition, ImplementationCohortRecord, ArtifactRef } from "../src/domain/dev-flow-v15";
import { advanceCohortUntilWait } from "../src/runtime/run-launch-dispatch";

const ref = { id: "00000000-0000-4000-8000-000000000001", version: 1 } as ArtifactRef;
const evaluatorDefinition = async (): Promise<ImplementationCohortDefinition> =>
  (await Bun.file(new URL("../../workflow-config/definitions/dev_flow_v15.json", import.meta.url)).json()).stages.implementation.cohort;
const pendingCohort = (): ImplementationCohortRecord => ({
  id: "00000000-0000-4000-8000-000000000010" as never,
  key: "core" as never,
  version: 0,
  state: "pending",
  depends_on: [],
  inputs: { brief: ref, repository: {
    refs: { repository_key: "oakridge" as never, repository_path: "/repo", integration_branch: "epic/wf",
      base_branch: "epic/schema", base_head_sha: "abc" as never },
    worktree_path: "/repo/worktree", worktree_base_sha: "abc" as never,
    canonical_branch: "cohort/core", expected_pr_base: "epic/schema",
  } },
  build: { state: "pending", outputs: { build_result: null, pr_summary: null }, sessions: [],
    active_execution_id: null, work: null, response: null, interrupted: null },
  assessment: { state: "pending", outputs: { assessment: null }, sessions: [],
    active_execution_id: null, work: null, response: null, interrupted: null },
  accepted_build: null,
});

test("implementation activation rejects an absent worktree base before selecting an execution", async () => {
  const pending = pendingCohort();
  const snapshot = { ...pending, inputs: { ...pending.inputs,
    repository: { ...pending.inputs.repository, worktree_base_sha: null } } };
  expect(evaluateCohort({ definition: await evaluatorDefinition(), snapshot, request: null,
    pr: null, available_artifacts: [ref] })).toMatchObject({ ok: false,
    error: { detail: expect.stringContaining("unavailable input inputs.repository") } });
});

test("the committed implementation tree starts a pending cohort with resolved frozen inputs", async () => {
  const selected = evaluateCohort({ definition: await evaluatorDefinition(), snapshot: pendingCohort(),
    request: null, pr: null, available_artifacts: [ref] });
  expect(selected).toEqual({ ok: true, value: {
    kind: "apply", expected_version: 0,
    changes: [{ kind: "set_cohort_state", state: "working" }, { kind: "set_worker_state", worker: "build", state: "working" }],
    actions: [{ worker: "build", action: { action_point: "initial", input: {
      brief: ref, repository: pendingCohort().inputs.repository as never,
    } } }],
  } });
});

test("a request invalid for the current state is a typed decision error", async () => {
  const selected = evaluateCohort({ definition: await evaluatorDefinition(), snapshot: pendingCohort(),
    request: { kind: "retry_build" }, pr: null, available_artifacts: [ref] });
  expect(selected).toEqual({ ok: false, error: expect.objectContaining({
    kind: "invalid_request", operation: "evaluate_cohort", cohort_id: pendingCohort().id,
  }) });
});

test("an inconsistent accepted builder is rejected before walking the tree", async () => {
  const snapshot = { ...pendingCohort(), state: "working" as const,
    build: { ...pendingCohort().build, state: "accepted" as const } };
  const selected = evaluateCohort({ definition: await evaluatorDefinition(), snapshot,
    request: null, pr: null, available_artifacts: [ref] });
  expect(selected).toEqual({ ok: false, error: expect.objectContaining({ kind: "invalid_state" }) });
});

const buildReviewCohort = (): ImplementationCohortRecord => {
  const pending = pendingCohort();
  const execution_id = "build-execution" as never;
  const build_result = { id: "00000000-0000-4000-8000-000000000002" as never,
    type: "dev.build_result" as const, version: 1, state: "unreviewed" as const,
    body: {} as never, provenance: { execution_id, session_id: null } };
  const pr_summary = { id: "00000000-0000-4000-8000-000000000003" as never,
    type: "dev.pr_summary" as const, version: 1, state: "unreviewed" as const,
    body: { pr_url: "https://example.test/pr/1" } as never,
    provenance: { execution_id, session_id: null } };
  return { ...pending, state: "working", build: { ...pending.build, state: "awaiting_review",
    active_execution_id: execution_id, outputs: { build_result, pr_summary },
    response: { execution_id, build_result: { id: build_result.id, version: 1 },
      pr_summary: { id: pr_summary.id, version: 1 }, head_sha: "abc" as never } } };
};
const buildTarget = () => ({ outputs: {
  build_result: { id: "00000000-0000-4000-8000-000000000002" as never, version: 1 },
  pr_summary: { id: "00000000-0000-4000-8000-000000000003" as never, version: 1 },
}, head_sha: "abc" as never });
const availableBuildRefs = () => [ref, buildTarget().outputs.build_result, buildTarget().outputs.pr_summary];

test("accept_build resolves the assessment launch from current build content", async () => {
  const selected = evaluateCohort({ definition: await evaluatorDefinition(), snapshot: buildReviewCohort(),
    request: { kind: "accept_build", target: buildTarget() }, pr: null, available_artifacts: availableBuildRefs() });
  expect(selected.ok && selected.value.kind === "apply" && selected.value.actions).toEqual([{
    worker: "assessment", action: { action_point: "initial", input: {
      brief: ref, repository: pendingCohort().inputs.repository as never,
      accepted_build: { outputs: buildTarget().outputs, head_sha: "abc" as never, pr_url: "https://example.test/pr/1" },
    } },
  }]);
});

test("both build-change requests select revise with their distinct feedback sources", async () => {
  const definition = await evaluatorDefinition();
  const build = buildReviewCohort();
  const buildFeedback = { source: "build_review" as const, text: "fix tests", target: buildTarget() };
  const fromBuild = evaluateCohort({ definition, snapshot: build,
    request: { kind: "request_build_changes", feedback: buildFeedback }, pr: null,
    available_artifacts: availableBuildRefs() });
  const accepted_build = { outputs: buildTarget().outputs, head_sha: "abc" as never, pr_url: "https://example.test/pr/1" };
  const assessmentRef = { id: "00000000-0000-4000-8000-000000000004" as never, version: 1 };
  const assessment = { ...build, build: { ...build.build, state: "accepted" as const }, accepted_build,
    assessment: { ...build.assessment, state: "awaiting_review" as const,
      work: { action_point: "initial" as const, input: { brief: ref,
        repository: pendingCohort().inputs.repository as never, accepted_build } }, outputs: {
      assessment: { id: assessmentRef.id, type: "dev.assessment" as const, version: 1,
        state: "unreviewed" as const, body: {} as never,
        provenance: { execution_id: "assessment-execution" as never, session_id: null } },
    } } };
  const assessmentFeedback = { source: "assessment" as const, text: "revise implementation",
    target: { assessment: assessmentRef, build: accepted_build } };
  const fromAssessment = evaluateCohort({ definition, snapshot: assessment,
    request: { kind: "request_implementation_changes", feedback: assessmentFeedback }, pr: null,
    available_artifacts: [...availableBuildRefs(), assessmentRef] });
  expect(fromBuild.ok && fromAssessment.ok && fromBuild.value.kind === "apply"
    && fromAssessment.value.kind === "apply" && {
      build_action: fromBuild.value.actions[0], assessment_action: fromAssessment.value.actions[0],
      same_changes: JSON.stringify(fromBuild.value.changes) === JSON.stringify(fromAssessment.value.changes),
    }).toEqual({ build_action: expect.objectContaining({ worker: "build",
    action: expect.objectContaining({ action_point: "revise", input: expect.objectContaining({ feedback: buildFeedback }) }) }),
    assessment_action: expect.objectContaining({ worker: "build",
      action: expect.objectContaining({ action_point: "revise", input: expect.objectContaining({ feedback: assessmentFeedback }) }) }),
    same_changes: true });
  const discuss = evaluateCohort({ definition, snapshot: assessment,
    request: { kind: "discuss_assessment", feedback: assessmentFeedback }, pr: null,
    available_artifacts: [...availableBuildRefs(), assessmentRef] });
  expect(discuss.ok && discuss.value.kind === "apply" && {
    action: discuss.value.actions[0], builder_changed: discuss.value.changes.some((change) =>
      "worker" in change && change.worker === "build"),
    accepted_build_cleared: discuss.value.changes.some((change) => change.kind === "clear_accepted_build"),
  }).toEqual({ action: expect.objectContaining({ worker: "assessment",
    action: expect.objectContaining({ action_point: "discuss" }) }),
    builder_changed: false, accepted_build_cleared: false });
});

test("a stale build review target makes no selected changes", async () => {
  const stale = { ...buildTarget(), head_sha: "stale" as never };
  expect(evaluateCohort({ definition: await evaluatorDefinition(), snapshot: buildReviewCohort(),
    request: { kind: "accept_build", target: stale }, pr: null, available_artifacts: availableBuildRefs() }))
    .toEqual({ ok: false, error: expect.objectContaining({ kind: "stale_review", operation: "evaluate_cohort" }) });
});

test("revision input rejects a nested artifact reference missing from the ledger", async () => {
  const selected = evaluateCohort({ definition: await evaluatorDefinition(), snapshot: buildReviewCohort(),
    request: { kind: "request_build_changes", feedback: {
      source: "build_review", text: "revise", target: buildTarget(),
    } }, pr: null, available_artifacts: [ref] });
  expect(selected).toEqual({ ok: false, error: expect.objectContaining({ kind: "unavailable_input" }) });
});

test("the evaluator refuses contradictory writes and missing action prompts", async () => {
  const definition = await evaluatorDefinition();
  const contradictory = { ...definition, decision_tree: { kind: "apply" as const, changes: [
    { kind: "set_cohort_state" as const, state: "working" as const },
    { kind: "set_cohort_state" as const, state: "complete" as const },
  ], actions: [] } };
  expect(evaluateCohort({ definition: contradictory, snapshot: pendingCohort(), request: null,
    pr: null, available_artifacts: [ref] })).toEqual({ ok: false,
      error: expect.objectContaining({ kind: "invalid_definition" }) });
  const missingPrompt = { ...definition, workers: { ...definition.workers,
    build: { ...definition.workers.build, action_points: { ...definition.workers.build.action_points,
      initial: { ...definition.workers.build.action_points.initial, prompt: "" } } } } };
  expect(evaluateCohort({ definition: missingPrompt, snapshot: pendingCohort(), request: null,
    pr: null, available_artifacts: [ref] })).toEqual({ ok: false,
      error: expect.objectContaining({ kind: "unavailable_input" }) });
});

test("one accept_build request commits the assessor launch then reaches a wait", async () => {
  const definition = await evaluatorDefinition();
  let snapshot = buildReviewCohort();
  const receipts: string[] = [];
  const dispatched: string[] = [];
  const result = await advanceCohortUntilWait({
    load: async () => ({ definition, snapshot, pr: null, available_artifacts: availableBuildRefs() }),
    commit: async (decision, request) => {
      receipts.push(request?.request.kind ?? "automatic");
      if (decision.actions[0]?.worker !== "assessment") throw new Error("assessment launch was not selected");
      snapshot = { ...snapshot, version: snapshot.version + 1,
        build: { ...snapshot.build, state: "accepted" },
        accepted_build: { outputs: buildTarget().outputs, head_sha: "abc" as never,
          pr_url: "https://example.test/pr/1" },
        assessment: { ...snapshot.assessment, state: "working", active_execution_id: "assessment-execution" as never } };
      return { ok: true, value: { transition_id: "00000000-0000-4000-8000-000000000020" as never,
        resulting_version: snapshot.version, execution_ids: ["assessment-execution" as never] } };
    },
    dispatch: async (ids) => { dispatched.push(...ids); },
  }, { id: "00000000-0000-4000-8000-000000000021" as never, cohort_id: snapshot.id,
    expected_version: 0, request: { kind: "accept_build", target: buildTarget() } });
  expect({ result, receipts, dispatched }).toEqual({
    result: { ok: true, value: { commits: 1, reason: "assessment response pending" } },
    receipts: ["accept_build"], dispatched: ["assessment-execution"],
  });
});

test("completed builder output is reviewable even when its execution was interrupted", async () => {
  const ready = buildReviewCohort();
  const snapshot = { ...ready, build: { ...ready.build, state: "working" as const,
    interrupted: { work: { action_point: "initial" as const, input: { brief: ref,
      repository: pendingCohort().inputs.repository as never } },
      execution: { execution_id: ready.build.active_execution_id!, session_id: null, detail: "transport lost" },
      build_result: buildTarget().outputs.build_result, pr_summary: buildTarget().outputs.pr_summary } } };
  const selected = evaluateCohort({ definition: await evaluatorDefinition(), snapshot,
    request: null, pr: null, available_artifacts: availableBuildRefs() });
  expect(selected.ok && selected.value.kind === "apply" && selected.value.changes).toContainEqual(
    { kind: "set_worker_state", worker: "build", state: "awaiting_review" });
});

test("spec readiness and interruption are independent facts over the same snapshot", () => {
  const context = { stage: "spec_analysis" as const, cohort: {
    spec: { active_execution_id: "spec-execution", response: { execution_id: "spec-execution", current: ref },
      outputs: { spec_analysis: { id: ref.id, version: ref.version } },
      interrupted: { execution: { execution_id: "spec-execution" } } },
  } as never };
  expect(evaluateV15Fact(context, "spec_outputs_ready")).toBe(true);
  expect(evaluateV15Fact(context, "spec_execution_interrupted")).toBe(true);
});

test("plan readiness rejects an empty plan even when publication completed", () => {
  const cohort = { inputs: { repositories: [{ repository_key: "oakridge", ref }] },
    plan: { active_execution_id: "plan-execution", response: { execution_id: "plan-execution", current: ref },
      outputs: { plan: { id: ref.id, version: ref.version, body: { cohorts: [] } } } } } as never;
  expect(evaluateV15Fact({ stage: "planning", cohort }, "plan_outputs_ready")).toBe(false);
});

test("final readiness requires a verified PR at the prepared base branch", () => {
  const pr = { pr_url: "https://example.test/pr/1", repository_key: "oakridge" as never,
    head_branch: "epic/schema", base_branch: "epic/wf", head_sha: "abc" as never, state: "open" as const };
  const cohort = { inputs: { repository: { repository_key: "oakridge", base_branch: "epic/schema",
    integration_branch: "epic/wf" } }, final_integration: { active_execution_id: "final-execution",
    response: { execution_id: "final-execution", current: ref },
    outputs: { pr_summary: { ...ref, body: { pr_url: pr.pr_url } } } } } as never;
  expect(evaluateV15Fact({ stage: "final_integration", cohort, pr, reviewed_target: null }, "final_outputs_ready")).toBe(true);
  expect(evaluateV15Fact({ stage: "final_integration", cohort, pr: { ...pr, head_branch: "other" },
    reviewed_target: null }, "final_outputs_ready")).toBe(false);
});

test("a final merge must match the reviewed head", () => {
  const target = { pr_summary: ref, pr_url: "https://example.test/pr/1", head_sha: "abc" as never };
  const pr = { pr_url: target.pr_url, repository_key: "oakridge" as never,
    head_branch: "epic/schema", base_branch: "epic/wf", head_sha: "wrong" as never, state: "merged" as const };
  const cohort = { inputs: { repository: { repository_key: "oakridge", base_branch: "epic/schema", integration_branch: "epic/wf" } },
    final_integration: { outputs: { pr_summary: { id: ref.id, version: ref.version } } } } as never;
  expect(evaluateV15Fact({ stage: "final_integration", cohort, pr, reviewed_target: target },
    "final_pr_merged_at_reviewed_head")).toBe(false);
  expect(evaluateV15Fact({ stage: "final_integration", cohort, pr: { ...pr, head_sha: target.head_sha },
    reviewed_target: target }, "final_pr_merged_at_reviewed_head")).toBe(true);
  for (const moved of [{ ...pr, head_sha: target.head_sha, head_branch: "other" },
    { ...pr, head_sha: target.head_sha, base_branch: "other" },
    { ...pr, head_sha: target.head_sha, repository_key: "other" },
    { ...pr, head_sha: target.head_sha, pr_url: "https://example.test/pr/2" }]) {
    expect(evaluateV15Fact({ stage: "final_integration", cohort, pr: moved as never, reviewed_target: target },
      "final_pr_merged_at_reviewed_head")).toBe(false);
  }
});

test("each single-worker v15 stage resolves its initial leaf from frozen inputs", async () => {
  const definition = await Bun.file(new URL("../../workflow-config/definitions/dev_flow_v15.json", import.meta.url)).json();
  const base = { id: pendingCohort().id, key: "cohort" as never, version: 0,
    state: "pending" as const, depends_on: [] };
  const cases = [
    { stage: "repository_preparation", worker: "provision", inputs: {
      repository: { key: "oakridge", path: "/repo", integration_branch: "epic/wf", forge_repository: null },
      base_branch: "epic/schema",
    }, extra: { provision: { state: "pending", interrupted: null } }, refs: [] },
    { stage: "spec_analysis", worker: "spec", inputs: { brief_notes: "brief", repositories: [
      { repository_key: "oakridge", ref },
    ] }, extra: { spec: { state: "pending", outputs: { spec_analysis: null }, interrupted: null } }, refs: [ref] },
    { stage: "planning", worker: "plan", inputs: { spec_analysis: ref, repositories: [] },
      extra: { plan: { state: "pending", outputs: { plan: null }, interrupted: null } }, refs: [ref] },
    { stage: "brief_writing", worker: "brief", inputs: { plan: ref, repositories: [] },
      extra: { brief: { state: "pending", outputs: { briefs: [] }, interrupted: null } }, refs: [ref] },
    { stage: "final_integration", worker: "final_integration", inputs: {
      repository: { repository_key: "oakridge", repository_path: "/repo", integration_branch: "epic/wf",
        base_branch: "epic/schema", base_head_sha: "abc" }, completed_cohorts: [],
    }, extra: { final_integration: { state: "pending", interrupted: null } }, refs: [] },
  ] as const;
  for (const item of cases) {
    const result = evaluateV15Cohort({ definition: definition.stages[item.stage].cohort,
      context: { stage: item.stage, cohort: { ...base, inputs: item.inputs, ...item.extra },
        ...(item.stage === "final_integration" ? { pr: null, reviewed_target: null } : {}) } as never,
      request: null, available_artifacts: item.refs });
    expect(result.ok && result.value.kind === "apply" && result.value.actions[0]?.worker).toBe(item.worker);
  }
});
