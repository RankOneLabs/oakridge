import { expect, test } from "bun:test";

import { compileWorkflowDefinition } from "../src/compiler/compile-workflow";
import { materializeStage } from "../src/compiler/materialize-stage";
import { appendIncrementalUnit, emptyIncrementalMaterialization, selectDriverArtifacts, selectReadyUnits, type IncrementalMaterialization } from "../src/compiler/materialize-units";
import { resolveDelegatedExecution } from "../src/compiler/resolve-execution";
import type { CompiledStageContract, MaterializedExecutionUnit } from "../src/domain/compiled-workflow";
import type { DelegatedSessionDefinitionConfig } from "../src/domain/delegated-session";
import type { ArtifactEnvelope } from "../src/domain/execution";
import type { ArtifactId, JsonValue, StageInstanceId, UnitId } from "../src/domain/primitives";
import { loadDevFlowV11 } from "../src/seed/dev-flow-v11";
import { selectInputsForUnit, type StageInputSet } from "../src/workflows/production-topology";

const stageInstanceId = "stage-1" as StageInstanceId;
const context = {
  brief_notes: "Build the requested change",
  repositories: [{ key: "oakridge", path: "/repo/oakridge", epic_branch: "epic/test", base_branch: "main" }],
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

const loadCompiled = async () => {
  const loaded = await loadDevFlowV11();
  if (!loaded.ok) throw new Error(loaded.error.detail);
  const compiled = compileWorkflowDefinition(loaded.value);
  if (!compiled.ok) throw new Error(compiled.error.detail);
  return compiled.value;
};

const resolveStage = async (stage: CompiledStageContract, unit: MaterializedExecutionUnit, inputs: StageInputSet) => {
  const definition = stage.executor.definition_config as DelegatedSessionDefinitionConfig;
  const template = await Bun.file(new URL(`../../oakridge-core/prompts/${definition.prompt_template_path}`, import.meta.url)).text();
  const unitInputs = selectInputsForUnit(inputs, unit, stage.materialization.kind === "fan_out");
  return resolveDelegatedExecution({ definition, environment: { inputs: unitInputs, context, item: null }, unit, stage_instance_id: stageInstanceId, prompt_template: template });
};

test("seeded spec, plan, and brief stages resolve their real prompts and release contracts", async () => {
  const workflow = await loadCompiled();
  const spec = workflow.stages.spec_analyzer!;
  const specUnits = materializeStage(spec, { inputs: {}, context, item: null });
  expect(specUnits.ok).toBe(true);
  if (!specUnits.ok) return;
  const specExecution = await resolveStage(spec, specUnits.value[0]!, {});
  expect(specExecution).toEqual({ ok: true, value: expect.objectContaining({ session_name: "spec-analyzer-stage-1", rendered_prompt: expect.stringContaining("Build the requested change") }) });
  expect(spec.outputs[0]?.release).toEqual(expect.objectContaining({ kind: "gate", requires_zero_open_review_items: true }));

  const specArtifact = envelope("spec-1", "dev.spec_analysis", "spec_analysis", "0", { requirements: ["one"] });
  const plan = workflow.stages.plan_writer!;
  const planUnits = materializeStage(plan, { inputs: { spec_analysis: specArtifact }, context, item: null });
  if (!planUnits.ok) throw new Error(planUnits.error.detail);
  const planExecution = await resolveStage(plan, planUnits.value[0]!, { spec_analysis: specArtifact });
  expect(planExecution).toEqual({ ok: true, value: expect.objectContaining({ rendered_prompt: expect.stringContaining('"requirements":["one"]') }) });
  expect(plan.outputs[0]?.release).toEqual(expect.objectContaining({ kind: "gate", requires_zero_open_review_items: false }));

  const planArtifact = envelope("plan-1", "dev.plan", "plan", "0", { cohorts: [{ id: "foundation" }, { id: "web" }] });
  const brief = workflow.stages.brief_writer!;
  const briefUnits = materializeStage(brief, { inputs: { plan: planArtifact }, context, item: null });
  expect(briefUnits).toEqual({ ok: true, value: [expect.objectContaining({ unit_id: "0", parameters: [{ id: "foundation" }, { id: "web" }] })] });
  expect(brief.outputs[0]?.release.kind).toBe("gate");
});

test("seeded build stage owns runtime cardinality, dependency readiness, and per-unit inputs", async () => {
  const workflow = await loadCompiled();
  const build = workflow.stages.build!;
  const briefs = [
    envelope("brief-1", "dev.build_brief", "brief", "foundation", { cohort_id: "foundation", repository_key: "oakridge", title: "Foundation", goal: "base", files_in_scope: [], next_action: "build", decisions_made: [], acceptance_criteria: ["base works"], depends_on: [] }),
    envelope("brief-2", "dev.build_brief", "brief", "web", { cohort_id: "web", repository_key: "oakridge", title: "Web", goal: "ui", files_in_scope: [], next_action: "build", decisions_made: [], acceptance_criteria: ["ui works"], depends_on: ["foundation"] }),
  ];
  const units = materializeStage(build, { inputs: { brief: briefs }, context, item: null });
  expect(units.ok).toBe(true);
  if (!units.ok) return;
  expect(units.value.map((unit) => [String(unit.unit_id), unit.depends_on.map(String)])).toEqual([["foundation", []], ["web", ["foundation"]]]);
  const admitted = new Set(units.value.map((unit) => unit.unit_id));
  expect(selectReadyUnits(units.value, { released: new Set(), admitted, launched: new Set(), running_count: 0, max_parallel: 4 }).map((unit) => String(unit.unit_id))).toEqual(["foundation"]);
  const afterFoundation = new Set(["foundation" as UnitId]);
  expect(selectReadyUnits(units.value, { released: afterFoundation, admitted, launched: afterFoundation, running_count: 0, max_parallel: 4 }).map((unit) => String(unit.unit_id))).toEqual(["web"]);

  const web = units.value.find((unit) => unit.unit_id === "web")!;
  const webInputs = selectInputsForUnit({ brief: briefs }, web, true);
  expect(webInputs.brief).toEqual([briefs[1]]);
  const execution = await resolveStage(build, web, { brief: briefs });
  expect(execution).toEqual({ ok: true, value: expect.objectContaining({ workdir: "/repo/oakridge", rendered_prompt: expect.stringContaining("**ID:** web"),
    worktree: { branchName: "cohort/stage-1/web", worktreeSubdir: "stage-1/web", baseRef: "epic/test" } }) });
  expect(build.outputs.find((output) => output.name === "build_result")?.release).toEqual(expect.objectContaining({ kind: "handoff", downstream_role: "assessment", external_wait_kind: "github_review" }));
});

test("seeded assessor pairs each build result with only its matching brief", async () => {
  const workflow = await loadCompiled();
  const assessor = workflow.stages.assessor!;
  const briefs = [
    envelope("brief-1", "dev.build_brief", "brief", "foundation", { repository_key: "oakridge", acceptance_criteria: ["base works"] }),
    envelope("brief-2", "dev.build_brief", "brief", "web", { repository_key: "oakridge", acceptance_criteria: ["ui works"] }),
  ];
  const results = [
    envelope("result-1", "dev.build_result", "build_result", "foundation", { repository_key: "oakridge", summary: "base done" }),
    envelope("result-2", "dev.build_result", "build_result", "web", { repository_key: "oakridge", summary: "web done" }),
  ];
  const inputs = { brief: briefs, build_result: results };
  const units = materializeStage(assessor, { inputs, context, item: null });
  if (!units.ok) throw new Error(units.error.detail);
  const web = units.value.find((unit) => unit.unit_id === "web")!;
  expect(selectInputsForUnit(inputs, web, true)).toEqual({ brief: [briefs[1]], build_result: [results[1]] });
  const execution = await resolveStage(assessor, web, inputs);
  expect(execution).toEqual({ ok: true, value: expect.objectContaining({ rendered_prompt: expect.stringContaining("ui works") }) });
  if (execution.ok) expect(execution.value.rendered_prompt).not.toContain("base works");
  expect(assessor.outputs[0]?.release).toEqual(expect.objectContaining({ kind: "gate", revision_target: "upstream_handoff" }));
});

test("seeded assessor mints one unit per build result, never one per brief", async () => {
  const workflow = await loadCompiled();
  const assessor = workflow.stages.assessor!;
  // Briefs and build results carry the same unit_id per repository. Seeding
  // units from both collides on unit_id and fails the stage before it launches.
  const briefs = [envelope("brief-1", "dev.build_brief", "brief", "web", { repository_key: "oakridge" })];
  const results = [envelope("result-1", "dev.build_result", "build_result", "web", { repository_key: "oakridge" })];
  const driving = selectDriverArtifacts<ArtifactEnvelope>(assessor.materialization, { brief: briefs, build_result: results });
  expect(driving).toEqual(results);
});

test("a fan-out driven by a non-input binding mints nothing rather than guessing an input", () => {
  const materialization = { kind: "fan_out", over: { from: "context", path: "/repositories" }, unit_id_path: "/unit_id", depends_on_path: null, max_parallel: 1, manual_admission: false } as const;
  expect(selectDriverArtifacts(materialization, { brief: [envelope("brief-1", "dev.build_brief", "brief", "web", {})] })).toEqual([]);
});

test("a scalar stage has no driver input, so nothing fans out of it", async () => {
  const workflow = await loadCompiled();
  const planWriter = workflow.stages.plan_writer!;
  expect(planWriter.materialization.kind).toBe("scalar");
  expect(selectDriverArtifacts(planWriter.materialization, { anything: [envelope("a", "t", "o", "u", {})] })).toEqual([]);
});

test("seeding from every incremental input collides on unit_id — the reason only the driver mints", async () => {
  const workflow = await loadCompiled();
  const assessor = workflow.stages.assessor!;
  if (assessor.materialization.kind !== "fan_out") throw new Error("assessor must fan out");
  const spec = { unit_id_path: assessor.materialization.unit_id_path, depends_on_path: assessor.materialization.depends_on_path };
  const seed = (state: IncrementalMaterialization, artifact: ArtifactEnvelope) =>
    appendIncrementalUnit(state, { unit_id: artifact.unit_id, artifact: artifact.body }, spec);
  const brief = envelope("brief-1", "dev.build_brief", "brief", "web", { repository_key: "oakridge" });
  const result = envelope("result-1", "dev.build_result", "build_result", "web", { repository_key: "oakridge" });
  const first = seed(emptyIncrementalMaterialization(), brief);
  if (!first.ok) throw new Error(first.error.detail);
  expect(seed(first.value, result)).toEqual({ ok: false, error: expect.objectContaining({ unit_id: "web", detail: "duplicate unit_id" }) });
});
