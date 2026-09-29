import { expect, test } from "bun:test";

import type { CompiledStageContract } from "../src/domain/compiled-workflow";
import type { DelegatedSessionDefinitionConfig } from "../src/domain/delegated-session";
import type { PromptBundle, WorkflowRunBundlePin } from "../src/domain/workflow";
import type { StageInstanceId, UnitId, WorkflowRunId } from "../src/domain/primitives";
import { resolveWorkOrder } from "../src/runtime/resolve-work-order";

const RUN_ID = "11111111-1111-4111-8111-111111111111" as WorkflowRunId;
const STAGE_INSTANCE_ID = "22222222-2222-4222-8222-222222222222" as StageInstanceId;
const bundlePin: WorkflowRunBundlePin = { definition_version: 14, prompt_bundle_hash: "pinned-bundle", adapter_version: "kbbl-v2", artifact_schema_version: "v1" };
const promptBundle: PromptBundle = { version: 1, hash: bundlePin.prompt_bundle_hash, matrix: [
  { session_role: "build", launch_reason: "initial", template_path: "build.md", content: "Initial {{UNIT_ID}}" },
  { session_role: "build", launch_reason: "operator_retry", template_path: "build.md", content: "Retry {{UNIT_ID}}" },
  { session_role: "build", launch_reason: "input_revision", template_path: "build.md", content: "Revision {{UNIT_ID}}" },
] };

const definition: DelegatedSessionDefinitionConfig = {
  prompt_matrix: (["initial", "operator_retry", "input_revision"] as const).map((launch_reason) => ({ session_role: "build" as const, launch_reason, template_path: "build.md" })),
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

test("a delegated work order uses its UUID and the run-pinned prompt bundle", async () => {
  const requestedHashes: string[] = [];
  const workOrder = await resolveWorkOrder({
    run_id: RUN_ID,
    stage,
    stage_instance_id: STAGE_INSTANCE_ID,
    unit: { unit_id: "cohort-one" as UnitId, parameters: null, depends_on: [] },
    inputs: {},
    context: {},
    outputs: [{ identity: { kind: "scalar", output_name: "result" }, artifact_type: "dev.result", required: true, release: { kind: "immediate" } }],
    identity: "revision:fingerprint",
    launch_reason: "operator_retry",
    bundle_pin: bundlePin,
    capability_seed: "test-seed",
  }, {
    // A newer bundle may already exist, but resolution addresses the immutable
    // hash recorded when this run launched.
    load_prompt_bundle: async (hash) => { requestedHashes.push(hash); return hash === promptBundle.hash ? promptBundle : {
      ...promptBundle, hash: "newer-bundle", matrix: promptBundle.matrix.map((entry) => ({ ...entry, content: "Edited after launch" })),
    }; },
    find_work_order_attachment: async () => null,
  });

  expect((workOrder.request.resolved_config as { readonly session_name?: string }).session_name).toBe(workOrder.id);
  expect((workOrder.request.resolved_config as { readonly rendered_prompt?: string }).rendered_prompt).toContain("Retry cohort-one");
  expect((workOrder.request.resolved_config as { readonly rendered_prompt?: string }).rendered_prompt).not.toContain("Edited after launch");
  expect(requestedHashes).toEqual([bundlePin.prompt_bundle_hash]);
});
