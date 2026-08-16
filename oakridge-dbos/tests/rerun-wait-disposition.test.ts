import { expect, test } from "bun:test";

import { selectRerunWaitDisposition, type StageCommand } from "../src/workflows/production-topology";
import type { ArtifactId, UnitId } from "../src/domain/primitives";

const waitingUnit = "web" as UnitId;
const failedWorkflowId = "coordinator:unit:web";

test("a replacement naming the waiting unit and its failed execution resolves the wait", () => {
  const command: StageCommand = { kind: "replace_execution", unit_id: waitingUnit, failed_execution_workflow_id: failedWorkflowId, replacement_execution_workflow_id: "rerun:web" };
  expect(selectRerunWaitDisposition(command, waitingUnit, failedWorkflowId)).toEqual({ kind: "resolve", command });
});

test("a replacement for another unit is held for that unit rather than dropped", () => {
  expect(selectRerunWaitDisposition(
    { kind: "replace_execution", unit_id: "api" as UnitId, failed_execution_workflow_id: "coordinator:unit:api", replacement_execution_workflow_id: "rerun:api" },
    waitingUnit, failedWorkflowId,
  )).toEqual({ kind: "defer" });
});

test("a replacement naming a stale execution does not resolve the wait", () => {
  expect(selectRerunWaitDisposition(
    { kind: "replace_execution", unit_id: waitingUnit, failed_execution_workflow_id: "coordinator:unit:web:superseded", replacement_execution_workflow_id: "rerun:web" },
    waitingUnit, failedWorkflowId,
  )).toEqual({ kind: "defer" });
});

test("stage traffic is applied during a rerun wait instead of being consumed and lost", () => {
  const artifact = { artifact_id: "brief-b" as ArtifactId, artifact_type: "dev.brief", output_name: "brief", unit_id: "b" as UnitId, body: {} };
  const applied: readonly StageCommand[] = [
    { kind: "input_released", input_name: "brief", artifact },
    { kind: "input_closed", input_name: "brief" },
    { kind: "admit_unit", unit_id: "api" as UnitId },
    { kind: "abandon_stage", reason: "operator cancelled the stage" },
  ];
  for (const command of applied) expect(selectRerunWaitDisposition(command, waitingUnit, failedWorkflowId)).toEqual({ kind: "apply" });
});
