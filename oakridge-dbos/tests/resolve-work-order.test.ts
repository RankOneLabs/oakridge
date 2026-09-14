import { expect, test } from "bun:test";

import type { CompiledStageContract } from "../src/domain/compiled-workflow";
import type { DelegatedSessionDefinitionConfig } from "../src/domain/delegated-session";
import type { StageInstanceId, UnitId, WorkflowRunId } from "../src/domain/primitives";
import { resolveWorkOrder } from "../src/runtime/resolve-work-order";

const RUN_ID = "11111111-1111-4111-8111-111111111111" as WorkflowRunId;
const STAGE_INSTANCE_ID = "22222222-2222-4222-8222-222222222222" as StageInstanceId;

const definition: DelegatedSessionDefinitionConfig = {
  runtime: { from: "literal", value: "claude-code" },
  prompt_template_path: "build.md",
  slot_bindings: { OAKRIDGE_URL: { from: "literal", value: "http://oakridge.test" } },
  workdir: { from: "literal", value: "/repo" },
  session_name: "build-{{STAGE_INSTANCE_ID}}-{{UNIT_ID}}",
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

test("a delegated work order uses its UUID as the kbbl session name", async () => {
  const workOrder = await resolveWorkOrder({
    run_id: RUN_ID,
    stage,
    stage_instance_id: STAGE_INSTANCE_ID,
    unit: { unit_id: "cohort-one" as UnitId, parameters: null, depends_on: [] },
    inputs: {},
    context: {},
    outputs: [{ identity: { kind: "scalar", output_name: "result" }, artifact_type: "dev.result", required: true, release: { kind: "immediate" } }],
    identity: "initial",
    capability_seed: "test-seed",
  }, {
    load_prompt_template: async () => "Build {{UNIT_ID}}",
    find_work_order_attachment: async () => null,
  });

  expect((workOrder.request.resolved_config as { readonly session_name?: string }).session_name).toBe(workOrder.id);
});
