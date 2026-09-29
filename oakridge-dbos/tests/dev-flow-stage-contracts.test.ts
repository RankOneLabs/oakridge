import { expect, test } from "bun:test";

import { compileWorkflowDefinition } from "../src/compiler/compile-workflow";
import { resolveDelegatedExecution } from "../src/compiler/resolve-execution";
import type { StageInputSet } from "../src/decision/commands";
import type { CompiledStageContract, MaterializedExecutionUnit } from "../src/domain/compiled-workflow";
import type { DelegatedSessionDefinitionConfig } from "../src/domain/delegated-session";
import type { DevFlowBuildCohort } from "../src/domain/cohort-pull-request";
import type { ArtifactEnvelope } from "../src/domain/execution";
import type { ArtifactId, CohortId, JsonValue, RunTransitionId, StageInstanceId, UnitId, WorkflowRunId } from "../src/domain/primitives";
import { loadDevFlowV15 } from "../src/seed/dev-flow-v15";
import { resolveWorkOrder } from "../src/runtime/resolve-work-order";

const stageInstanceId = "stage-1" as StageInstanceId;
const runId = "run-1" as WorkflowRunId;
const context = {
  brief_notes: "Build the requested change",
  base_branch: "epic/test",
  repositories: [{ key: "oakridge", path: "/repo/oakridge", integration_branch: "main" }],
  oakridge_url: "http://127.0.0.1:8790",
  planner_runtime: "claude-code",
  planner_model: "opus",
  planner_effort: "high",
  worker_runtime: "claude-code",
  worker_model: "opus",
  worker_effort: "high",
} as const;

const envelope = (artifact_id: string, artifact_type: string, output_name: string, unit_id: string, body: JsonValue): ArtifactEnvelope => ({
  artifact_id: artifact_id as ArtifactId,
  artifact_type,
  output_name,
  unit_id: unit_id as UnitId,
  body,
});

/** What the provisioning stage guaranteed for the repository the cohorts build in. */
const repositoryRefs = [envelope("refs-1", "dev.repository_refs", "repository_refs", "oakridge", {
  repository_key: "oakridge", repository_path: "/repo/oakridge", integration_branch: "main", base_branch: "epic/test", base_head_sha: "9a8b7c6",
})];

const buildCohort: DevFlowBuildCohort = {
  cohort_id: "11111111-1111-4111-8111-111111111112" as CohortId,
  stage_instance_id: stageInstanceId,
  cohort_key: "web",
  repository_key: "oakridge",
  repository_path: "/repo/oakridge",
  canonical_ref: "cohort/stage-1/web",
  expected_pr_base: "epic/test",
  recorded_head_sha: "9a8b7c6",
  current_verified_pull_request_id: null,
  created_at: "2026-09-29T00:00:00.000Z",
  updated_at: "2026-09-29T00:00:00.000Z",
};

const loadCompiled = async () => {
  const loaded = await loadDevFlowV15();
  if (!loaded.ok) throw new Error(loaded.error.detail);
  const compiled = compileWorkflowDefinition(loaded.value);
  if (!compiled.ok) throw new Error(compiled.error.detail);
  return compiled.value;
};

/**
 * Resolves a unit's execution the way `apply` does: against inputs already
 * filtered to the unit — `derive`'s per-unit filtering (formerly
 * `selectInputsForUnit`) is not re-run here, since the caller hands over
 * exactly what production would.
 */
const resolveStage = async (stage: CompiledStageContract, unit: MaterializedExecutionUnit, inputs: StageInputSet,
  role = stage.operator_role, reason?: string) => {
  const definition = stage.executor.definition_config as DelegatedSessionDefinitionConfig;
  const prompt = definition.prompt_matrix.find((entry) => entry.session_role === role && (reason === undefined || entry.launch_reason === reason));
  if (!prompt) throw new Error(`missing initial prompt for ${stage.stage_key}`);
  const template = await Bun.file(new URL(`../../workflow-config/prompts/${prompt.template_path}`, import.meta.url)).text();
  return resolveDelegatedExecution({ definition, environment: { inputs, context, item: null }, unit, stage_instance_id: stageInstanceId, prompt_template: template,
    run_id: runId, operator_role: role, launch_reason: prompt.launch_reason });
};

const scalarUnit: MaterializedExecutionUnit = { unit_id: "0" as UnitId, parameters: {}, depends_on: [] };

test("seeded spec and plan stages resolve their real prompts and release contracts", async () => {
  const workflow = await loadCompiled();
  const spec = workflow.stages.spec_analyzer!;
  // Every planning stage declares `repository_refs` now: it is what guarantees
  // the base branch exists in the directory the session will run in, and it is
  // where the working directory itself is resolved from.
  const specExecution = await resolveStage(spec, scalarUnit, { repository_refs: repositoryRefs });
  expect(specExecution).toEqual({ ok: true, value: expect.objectContaining({ session_name: "spec-analyzer-stage-1",
    workdir: "/repo/oakridge", rendered_prompt: expect.stringContaining("Build the requested change") }) });
  expect(spec.outputs[0]?.release).toEqual(expect.objectContaining({ kind: "gate", requires_zero_open_review_items: true }));

  const specArtifact = envelope("spec-1", "dev.spec_analysis", "spec_analysis", "0", { requirements: ["one"] });
  const plan = workflow.stages.plan_writer!;
  const planInputs = { spec_analysis: specArtifact, repository_refs: repositoryRefs };
  const planExecution = await resolveStage(plan, scalarUnit, planInputs);
  expect(planExecution).toEqual({ ok: true, value: expect.objectContaining({ rendered_prompt: expect.stringContaining('"requirements":["one"]') }) });
  if (planExecution.ok) {
    expect(planExecution.value.rendered_prompt).toContain('"base_branch":"epic/test"');
    expect(planExecution.value.rendered_prompt).toContain('"integration_branch":"main"');
  }
  expect(plan.outputs[0]?.release).toEqual(expect.objectContaining({ kind: "gate", requires_zero_open_review_items: false }));

  const brief = workflow.stages.brief_writer!;
  expect(brief.outputs[0]?.release.kind).toBe("gate");
});

test("seeded build stage resolves a cohort's real prompt, worktree, and release contract", async () => {
  const workflow = await loadCompiled();
  const build = workflow.stages.build!;
  const briefBody = { cohort_id: "web", repository_key: "oakridge", title: "Web", goal: "ui", files_in_scope: [], next_action: "build", decisions_made: [], acceptance_criteria: ["ui works"], depends_on: ["foundation"] };
  const brief = envelope("brief-2", "dev.build_brief", "brief", "web", briefBody);
  const web: MaterializedExecutionUnit = { unit_id: "web" as UnitId, parameters: { unit_id: "web", artifact: briefBody }, depends_on: ["foundation" as UnitId] };
  const inputs = { brief: [brief], repository_refs: repositoryRefs };
  const execution = await resolveStage(build, web, inputs);
  expect(execution).toEqual({ ok: true, value: expect.objectContaining({ workdir: "/repo/oakridge", rendered_prompt: expect.stringContaining("- ID: web"),
    worktree: { branchName: "cohort/stage-1/web", worktreeSubdir: "stage-1/web", baseRef: "epic/test" } }) });
  expect(build.outputs.find((output) => output.name === "build_result")?.release).toEqual(expect.objectContaining({ kind: "gate", gate_name: "build_review" }));
  expect(build.outputs.find((output) => output.name === "assessment")?.release).toEqual(expect.objectContaining({ kind: "gate", gate_name: "assessment_review" }));
  const buildDefinition = build.executor.definition_config as DelegatedSessionDefinitionConfig;
  expect(buildDefinition.gates.find((gate) => gate.name === "build_review")?.steps).toEqual([
    { type: "artifact_approval", actions: ["approve", "request_revision"] },
  ]);
});

/**
 * The build stage reads its repository from the provisioning stage's artifact,
 * not from a pointer into the run context. What proves it is a context that
 * disagrees: the refs win, because they are what a stage actually guaranteed.
 */
test("seeded build resolves its worktree from the provisioned refs rather than the run context", async () => {
  const workflow = await loadCompiled();
  const build = workflow.stages.build!;
  const briefBody = { cohort_id: "foundation", repository_key: "oakridge", title: "Foundation", goal: "base", files_in_scope: [], next_action: "build", decisions_made: [], acceptance_criteria: ["base works"], depends_on: [] };
  const brief = envelope("brief-1", "dev.build_brief", "brief", "foundation", briefBody);
  const foundation: MaterializedExecutionUnit = { unit_id: "foundation" as UnitId, parameters: { unit_id: "foundation", artifact: briefBody }, depends_on: [] };
  const provisioned = [envelope("refs-1", "dev.repository_refs", "repository_refs", "oakridge", {
    repository_key: "oakridge", repository_path: "/provisioned/oakridge", integration_branch: "trunk", base_branch: "epic/provisioned", base_head_sha: "0f1e2d3",
  })];
  const execution = await resolveStage(build, foundation, { brief: [brief], repository_refs: provisioned });
  expect(execution).toEqual({ ok: true, value: expect.objectContaining({ workdir: "/provisioned/oakridge",
    worktree: expect.objectContaining({ baseRef: "epic/provisioned" }) }) });
});

/**
 * With no refs to look itself up in, a cohort refuses rather than guessing a
 * branch. The graph makes this unreachable — `repository_refs` is a required
 * input, so build cannot start before provisioning finishes — and that is
 * precisely why the failure has to be loud if it ever is reached.
 */
test("a build unit whose repository was never provisioned resolves to a named failure", async () => {
  const workflow = await loadCompiled();
  const build = workflow.stages.build!;
  const briefBody = { cohort_id: "foundation", repository_key: "absent", title: "Foundation", goal: "base", files_in_scope: [], next_action: "build", decisions_made: [], acceptance_criteria: [], depends_on: [] };
  const brief = envelope("brief-1", "dev.build_brief", "brief", "foundation", briefBody);
  const foundation: MaterializedExecutionUnit = { unit_id: "foundation" as UnitId, parameters: { unit_id: "foundation", artifact: briefBody }, depends_on: [] };
  const provisioned = [envelope("refs-1", "dev.repository_refs", "repository_refs", "oakridge", {
    repository_key: "oakridge", repository_path: "/repo/oakridge", base_branch: "main", epic_branch: "epic/test", epic_head_sha: "0f1e2d3",
  })];
  const execution = await resolveStage(build, foundation, { brief: [brief], repository_refs: provisioned });
  expect(execution).toEqual({ ok: false, error: expect.objectContaining({ detail: expect.stringContaining("input lookup key 'absent' matched 0 entries") }) });
});

test("the build stage's assessor role resolves its prompt in the same cohort", async () => {
  const workflow = await loadCompiled();
  const build = workflow.stages.build!;
  const briefBody = { cohort_id: "web", repository_key: "oakridge", title: "Web", goal: "ui", files_in_scope: [], next_action: "build", decisions_made: [], acceptance_criteria: ["ui works"], depends_on: [] };
  const brief = envelope("brief-2", "dev.build_brief", "brief", "web", briefBody);
  const result = envelope("result-2", "dev.build_result", "build_result", "web", { repository_key: "oakridge", summary: "web done" });
  const web: MaterializedExecutionUnit = { unit_id: "web" as UnitId, parameters: { unit_id: "web", artifact: briefBody }, depends_on: [] };
  const definition = build.executor.definition_config as DelegatedSessionDefinitionConfig;
  const prompt = definition.prompt_matrix.find((entry) => entry.session_role === "assessment" && entry.launch_reason === "initial_assessment");
  if (!prompt) throw new Error("missing initial assessor prompt");
  const template = await Bun.file(new URL(`../../workflow-config/prompts/${prompt.template_path}`, import.meta.url)).text();
  const workOrder = await resolveWorkOrder({ run_id: runId, stage: build, stage_instance_id: stageInstanceId, unit: web,
    inputs: { brief: [brief], repository_refs: repositoryRefs }, accepted_cohort_outputs: [result], context, outputs: [],
    identity: "assessment:initial", capability_seed: "test-seed",
    session_launch: { reason: { transition_id: "11111111-1111-4111-8111-111111111111" as RunTransitionId, name: "initial_assessment" },
      session_role: "assessment", prompt: { template_path: prompt.template_path, content: template }, existing_pull_request: "https://example.test/pull/7" } });
  const rendered = (workOrder.request.resolved_config as { readonly rendered_prompt: string }).rendered_prompt;
  expect(rendered).toContain("ui works");
  expect(rendered).toContain("web done");
  expect(rendered).not.toContain("base works");
  expect(build.outputs.find((output) => output.name === "assessment")?.release).toEqual(expect.objectContaining({ kind: "gate", gate_name: "assessment_review" }));
});

test("every spec prompt matrix cell renders the generated contract for valid and invalid slots", async () => {
  const workflow = await loadCompiled();
  const stage = workflow.stages.spec_analyzer!;
  const definition = stage.executor.definition_config as DelegatedSessionDefinitionConfig;
  const inputs = { repository_refs: repositoryRefs };
  for (const cell of definition.prompt_matrix) {
    const template = await Bun.file(new URL(`../../workflow-config/prompts/${cell.template_path}`, import.meta.url)).text();
    const representative = resolveDelegatedExecution({ definition, environment: { inputs, context, item: null }, unit: scalarUnit,
      stage_instance_id: stageInstanceId, prompt_template: template, run_id: runId, operator_role: cell.session_role, launch_reason: cell.launch_reason });
    expect(representative.ok).toBe(true);
    if (representative.ok) {
      expect(representative.value.rendered_prompt).toContain("## Generated session contract");
      expect(representative.value.rendered_prompt).toContain(`Launch reason: ${cell.launch_reason}`);
    }

    // A failed resolution is not dispatchable, but carries a diagnostic prompt
    // preview with the same contract block so every matrix cell remains
    // inspectable when a slot is absent or invalid.
    const invalid = resolveDelegatedExecution({ definition,
      environment: { inputs, context: { ...context, brief_notes: undefined } as unknown as JsonValue, item: null }, unit: scalarUnit,
      stage_instance_id: stageInstanceId, prompt_template: template, run_id: runId, operator_role: cell.session_role, launch_reason: cell.launch_reason });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error.rendered_prompt).toContain("## Generated session contract");
      expect(invalid.error.rendered_prompt).toContain(`Launch reason: ${cell.launch_reason}`);
    }
  }
});

test("every plan and brief prompt matrix cell renders its generated launch contract", async () => {
  const workflow = await loadCompiled();
  const specArtifact = envelope("spec-1", "dev.spec_analysis", "spec_analysis", "0", { requirements: ["one"] });
  const planBody = { cohorts: [{ id: "web", repository_key: "oakridge", title: "Web", scope: "ui", depends_on: [],
    description: "build", files_in_scope: [], decisions: [], acceptance_criteria: ["ui works"] }], dependency_order: ["web"] };
  const planArtifact = envelope("plan-1", "dev.plan", "plan", "0", planBody);
  const cases: readonly { readonly stage: CompiledStageContract; readonly inputs: StageInputSet }[] = [
    { stage: workflow.stages.plan_writer!, inputs: { spec_analysis: specArtifact, repository_refs: repositoryRefs } },
    { stage: workflow.stages.brief_writer!, inputs: { plan: planArtifact, repository_refs: repositoryRefs } },
  ];
  for (const item of cases) {
    const definition = item.stage.executor.definition_config as DelegatedSessionDefinitionConfig;
    for (const cell of definition.prompt_matrix) {
      const execution = await resolveStage(item.stage, scalarUnit, item.inputs, cell.session_role, cell.launch_reason);
      expect(execution.ok).toBe(true);
      if (execution.ok) {
        expect(execution.value.rendered_prompt).toContain("## Generated session contract");
        expect(execution.value.rendered_prompt).toContain(`Launch reason: ${cell.launch_reason}`);
      }
    }
  }
});

test("v15 has six stages and one prompt file for every stage, role, and reason cell", async () => {
  const loaded = await loadDevFlowV15();
  if (!loaded.ok) throw new Error(loaded.error.detail);
  expect(Object.keys(loaded.value.graph.stages).sort()).toEqual([
    "brief_writer", "build", "final_integration", "plan_writer", "provision_repository_refs", "spec_analyzer",
  ]);
  const cells = Object.values(loaded.value.graph.stages).flatMap((stage) => {
    if (stage.stage_type !== "delegated_session") return [];
    return (stage.config as unknown as DelegatedSessionDefinitionConfig).prompt_matrix;
  });
  expect(cells).toHaveLength(18);
  expect(new Set(cells.map((cell) => cell.template_path)).size).toBe(cells.length);
  expect(cells.every((cell) => cell.template_path.startsWith("dev-flow/v15/"))).toBe(true);
});

test("all eight build loop prompt cells render the persisted cohort branch contract", async () => {
  const workflow = await loadCompiled();
  const build = workflow.stages.build!;
  const definition = build.executor.definition_config as DelegatedSessionDefinitionConfig;
  const briefBody = { cohort_id: "web", repository_key: "oakridge", title: "Web", goal: "ui", files_in_scope: [],
    next_action: "build", decisions_made: [], acceptance_criteria: ["ui works"], depends_on: [] };
  const brief = envelope("brief-2", "dev.build_brief", "brief", "web", briefBody);
  const result = envelope("result-2", "dev.build_result", "build_result", "web", { repository_key: "oakridge", summary: "web done" });
  const web: MaterializedExecutionUnit = { unit_id: "web" as UnitId,
    parameters: { unit_id: "web", artifact: briefBody }, depends_on: [] };

  expect(definition.prompt_matrix).toHaveLength(8);
  for (const [index, cell] of definition.prompt_matrix.entries()) {
    const template = await Bun.file(new URL(`../../workflow-config/prompts/${cell.template_path}`, import.meta.url)).text();
    const workOrder = await resolveWorkOrder({ run_id: runId, stage: build, stage_instance_id: stageInstanceId, unit: web,
      inputs: { brief: [brief], repository_refs: repositoryRefs }, accepted_cohort_outputs: [result], context, outputs: [],
      identity: `matrix:${index}`, capability_seed: "test-seed", build_cohort: buildCohort,
      session_launch: { reason: { transition_id: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}` as RunTransitionId,
        name: cell.launch_reason }, session_role: cell.session_role,
        prompt: { template_path: cell.template_path, content: template },
        existing_pull_request: cell.launch_reason === "initial_build" ? null : "https://example.test/pull/7" } });
    const resolved = workOrder.request.resolved_config as { readonly rendered_prompt: string; readonly worktree?: { readonly branchName: string } };
    expect(resolved.rendered_prompt).toContain("## Generated session contract");
    expect(resolved.rendered_prompt).toContain(`Launch reason: ${cell.launch_reason}`);
    expect(resolved.rendered_prompt).toContain(`Canonical cohort ref: ${buildCohort.canonical_ref}`);
    expect(resolved.rendered_prompt).toContain(`Pull request base: ${buildCohort.expected_pr_base}`);
    if (cell.session_role === "build") {
      expect(resolved.worktree?.branchName).toBe(buildCohort.canonical_ref);
      expect(resolved.rendered_prompt).toContain("pr_url: string;");
      expect(resolved.rendered_prompt).toContain("delegated_session_metadata:");
      expect(resolved.rendered_prompt).toContain('severity: "blocking" | "warning" | "info";');
    }
  }
});

test("final integration renders its stored canonical ref and pull request base", async () => {
  const workflow = await loadCompiled();
  const stage = workflow.stages.final_integration!;
  const definition = stage.executor.definition_config as DelegatedSessionDefinitionConfig;
  const cell = definition.prompt_matrix[0]!;
  const template = await Bun.file(new URL(`../../workflow-config/prompts/${cell.template_path}`, import.meta.url)).text();
  const finalCohort: DevFlowBuildCohort = { ...buildCohort,
    cohort_id: "11111111-1111-4111-8111-111111111113" as CohortId,
    cohort_key: "oakridge", canonical_ref: "epic/test", expected_pr_base: "main" };
  const repositoryUnit: MaterializedExecutionUnit = { unit_id: "oakridge" as UnitId,
    parameters: { unit_id: "oakridge", artifact: repositoryRefs[0]!.body }, depends_on: [] };
  const inputs = {
    repository_refs: repositoryRefs,
    cohort_pr_summaries: [envelope("pr-1", "dev.pr_summary", "pr_summary", "web", { pr_url: "https://example.test/pull/7" })],
    build_results: [envelope("result-2", "dev.build_result", "build_result", "web", { summary: "web done" })],
    assessments: [envelope("assessment-2", "dev.assessment", "assessment", "web", { verdict: "pass" })],
  };
  const workOrder = await resolveWorkOrder({ run_id: runId, stage, stage_instance_id: stageInstanceId, unit: repositoryUnit,
    inputs, context, outputs: [], identity: "final:initial", capability_seed: "test-seed", build_cohort: finalCohort,
    session_launch: { reason: { transition_id: "11111111-1111-4111-8111-111111111114" as RunTransitionId, name: cell.launch_reason },
      session_role: cell.session_role, prompt: { template_path: cell.template_path, content: template }, existing_pull_request: null } });
  const resolved = workOrder.request.resolved_config as { readonly rendered_prompt: string; readonly workdir: string };
  expect(resolved.workdir).toBe("/repo/oakridge");
  expect(resolved.rendered_prompt).toContain(`Canonical cohort ref: ${finalCohort.canonical_ref}`);
  expect(resolved.rendered_prompt).toContain(`Pull request base: ${finalCohort.expected_pr_base}`);
  expect(stage.outputs[0]?.release).toEqual(expect.objectContaining({ kind: "gate", gate_name: "final_integration_review" }));
});
