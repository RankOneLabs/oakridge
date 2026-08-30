import { expect, test } from "bun:test";

import { compileWorkflowDefinition } from "../src/compiler/compile-workflow";
import { resolveDelegatedExecution } from "../src/compiler/resolve-execution";
import type { StageInputSet } from "../src/decision/commands";
import type { CompiledStageContract, MaterializedExecutionUnit } from "../src/domain/compiled-workflow";
import type { DelegatedSessionDefinitionConfig } from "../src/domain/delegated-session";
import type { ArtifactEnvelope } from "../src/domain/execution";
import type { ArtifactId, JsonValue, StageInstanceId, UnitId } from "../src/domain/primitives";
import { loadDevFlowV14 } from "../src/seed/dev-flow-v14";

const stageInstanceId = "stage-1" as StageInstanceId;
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

const loadCompiled = async () => {
  const loaded = await loadDevFlowV14();
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
const resolveStage = async (stage: CompiledStageContract, unit: MaterializedExecutionUnit, inputs: StageInputSet) => {
  const definition = stage.executor.definition_config as DelegatedSessionDefinitionConfig;
  const template = await Bun.file(new URL(`../../oakridge-core/prompts/${definition.prompt_template_path}`, import.meta.url)).text();
  return resolveDelegatedExecution({ definition, environment: { inputs, context, item: null }, unit, stage_instance_id: stageInstanceId, prompt_template: template });
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
  expect(execution).toEqual({ ok: true, value: expect.objectContaining({ workdir: "/repo/oakridge", rendered_prompt: expect.stringContaining("**ID:** web"),
    worktree: { branchName: "cohort/stage-1/web", worktreeSubdir: "stage-1/web", baseRef: "epic/test" } }) });
  expect(build.outputs.find((output) => output.name === "build_result")?.release).toEqual(expect.objectContaining({ kind: "handoff", downstream_role: "assessment", external_wait_kind: "github_review" }));
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
  if (execution.ok) expect(execution.value.rendered_prompt).toContain("epic/provisioned");
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

test("seeded assessor resolves its real prompt, pairing only the matching build result and brief", async () => {
  const workflow = await loadCompiled();
  const assessor = workflow.stages.assessor!;
  const brief = envelope("brief-2", "dev.build_brief", "brief", "web", { repository_key: "oakridge", acceptance_criteria: ["ui works"] });
  const result = envelope("result-2", "dev.build_result", "build_result", "web", { repository_key: "oakridge", summary: "web done" });
  const web: MaterializedExecutionUnit = { unit_id: "web" as UnitId, parameters: { unit_id: "web", artifact: result.body }, depends_on: [] };
  const inputs = { brief: [brief], build_result: [result], repository_refs: repositoryRefs };
  const execution = await resolveStage(assessor, web, inputs);
  expect(execution).toEqual({ ok: true, value: expect.objectContaining({ rendered_prompt: expect.stringContaining("ui works") }) });
  if (execution.ok) expect(execution.value.rendered_prompt).not.toContain("base works");
  expect(assessor.outputs[0]?.release).toEqual(expect.objectContaining({ kind: "gate", revision_target: "upstream_handoff" }));
});
