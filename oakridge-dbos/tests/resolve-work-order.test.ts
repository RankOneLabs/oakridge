import { expect, test } from "bun:test";

import type { CompiledStageContract } from "../src/domain/compiled-workflow";
import type { DelegatedSessionDefinitionConfig } from "../src/domain/delegated-session";
import type { ArtifactId, RunTransitionId, StageInstanceId, UnitId, WorkflowRunId } from "../src/domain/primitives";
import { resolveWorkOrder } from "../src/runtime/resolve-work-order";

const RUN_ID = "11111111-1111-4111-8111-111111111111" as WorkflowRunId;
const STAGE_INSTANCE_ID = "22222222-2222-4222-8222-222222222222" as StageInstanceId;

const definition: DelegatedSessionDefinitionConfig = {
  prompt_matrix: ["initial", "operator_retry", "input_revision", "revision_after_assessment"].map((launch_reason) => ({ session_role: "build" as const, launch_reason, template_path: "build.md" })),
  role_configs: [{ session_role: "build", runtime: { from: "literal", value: "claude-code" }, session_name: "build-{{STAGE_INSTANCE_ID}}-{{UNIT_ID}}",
    authorized_outputs: ["result"], pre_authorized_tools: [], required_tools: [] }],
  slot_bindings: { OAKRIDGE_URL: { from: "literal", value: "http://oakridge.test" } },
  workdir: { from: "literal", value: "/repo" },
  artifact_productions: [], gates: [], handoffs: [],
};

const stage: CompiledStageContract = {
  stage_key: "build",
  stage_type: "delegated_session",
  operator_role: "build",
  inputs: [],
  outputs: [{ name: "result", artifact_type: "dev.result", release: { kind: "immediate" } }],
  materialization: { kind: "scalar" },
  executor: { executor_type: "delegated_session", definition_config: definition },
};

test("a delegated work order uses the prompt and reason committed by its launch transition", async () => {
  const workOrder = await resolveWorkOrder({
    run_id: RUN_ID,
    stage,
    stage_instance_id: STAGE_INSTANCE_ID,
    unit: { unit_id: "cohort-one" as UnitId, parameters: null, depends_on: [] },
    inputs: {},
    context: {},
    outputs: [{ identity: { kind: "scalar", output_name: "result" }, artifact_type: "dev.result", required: true, release: { kind: "immediate" } }],
    identity: "revision:fingerprint",
    session_launch: {
      reason: { transition_id: "33333333-3333-4333-8333-333333333333" as RunTransitionId, name: "revision_after_assessment" },
      session_role: "build",
      prompt: { template_path: "build.md", content: "Revise {{UNIT_ID}}" },
      existing_pull_request: "https://example.test/pull/7",
    },
    capability_seed: "test-seed",
  });

  expect((workOrder.request.resolved_config as { readonly session_name?: string }).session_name).toBe(workOrder.id);
  expect((workOrder.request.resolved_config as { readonly rendered_prompt?: string }).rendered_prompt).toContain("Revise cohort-one");
  expect((workOrder.request.resolved_config as { readonly rendered_prompt?: string }).rendered_prompt).toContain("Existing PR: https://example.test/pull/7");
  expect(workOrder.request.session_launch?.reason).toEqual({ transition_id: "33333333-3333-4333-8333-333333333333" as RunTransitionId, name: "revision_after_assessment" });
});

test("an assessor work order injects its cohort's persisted build result", async () => {
  const assessmentDefinition: DelegatedSessionDefinitionConfig = {
    ...definition,
    prompt_matrix: [{ session_role: "assessment", launch_reason: "initial_assessment", template_path: "assessment.md" }],
    role_configs: [{ session_role: "assessment", runtime: { from: "literal", value: "claude-code" },
      session_name: "assessment-{{STAGE_INSTANCE_ID}}-{{UNIT_ID}}", authorized_outputs: ["assessment"], pre_authorized_tools: [], required_tools: [] }],
    slot_bindings: { ...definition.slot_bindings, BUILD_RESULT: { from: "input", input_name: "build_result", path: null } },
  };
  const assessmentStage: CompiledStageContract = {
    ...stage,
    operator_role: "assessment",
    outputs: [{ name: "assessment", artifact_type: "dev.assessment", release: { kind: "immediate" } }],
    executor: { executor_type: "delegated_session", definition_config: assessmentDefinition },
  };
  const workOrder = await resolveWorkOrder({
    run_id: RUN_ID,
    stage: assessmentStage,
    stage_instance_id: STAGE_INSTANCE_ID,
    unit: { unit_id: "cohort-one" as UnitId, parameters: null, depends_on: [] },
    inputs: {},
    accepted_cohort_outputs: [{ artifact_id: "44444444-4444-4444-8444-444444444444" as ArtifactId,
      artifact_type: "dev.build_result", output_name: "build_result", unit_id: "cohort-one" as UnitId,
      body: { repository_key: "oakridge", summary: "built from persisted output" } }],
    context: {},
    outputs: [{ identity: { kind: "scalar", output_name: "assessment" }, artifact_type: "dev.assessment", required: true, release: { kind: "immediate" } }],
    identity: "assessment:initial",
    session_launch: {
      reason: { transition_id: "55555555-5555-4555-8555-555555555555" as RunTransitionId, name: "initial_assessment" },
      session_role: "assessment",
      prompt: { template_path: "assessment.md", content: "Assess {{BUILD_RESULT}}" },
      existing_pull_request: "https://example.test/pull/7",
    },
    capability_seed: "test-seed",
  });

  const rendered = (workOrder.request.resolved_config as { readonly rendered_prompt?: string }).rendered_prompt;
  expect(rendered).toContain("built from persisted output");
  expect(workOrder.request.inputs.map((artifact) => String(artifact.artifact_id))).toEqual(["44444444-4444-4444-8444-444444444444"]);
});
