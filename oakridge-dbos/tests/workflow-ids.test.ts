import { expect, test } from "bun:test";

import type { ArtifactId, ExecutionId, UnitId } from "../src/domain/primitives";
import {
  executorFenceWorkflowId, gateRelayWorkflowId, gateWaitWorkflowId, gateWaitWorkflowIdFromRelay,
  handoffWorkflowId, HANDOFF_INFIX, relayWorkflowId, stageCoordinatorWorkflowId,
  terminalObserverWorkflowId, TERMINAL_OBSERVER_SUFFIX, unitExecutionWorkflowId,
  unitRevisionExecutionWorkflowId,
} from "../src/domain/workflow-ids";

const root = "oakridge-run:run-1:attempt:initial";
const artifact = "artifact-1" as ArtifactId;

test("the run tree composes from root to unit execution", () => {
  const coordinator = stageCoordinatorWorkflowId(root, "build");
  expect(String(coordinator)).toBe("oakridge-run:run-1:attempt:initial:stage:build");
  expect(unitExecutionWorkflowId(coordinator, "web" as UnitId)).toBe("oakridge-run:run-1:attempt:initial:stage:build:unit:web");
  expect(relayWorkflowId(coordinator)).toBe("oakridge-run:run-1:attempt:initial:stage:build:relay");
});

test("an execution's children are named off the execution itself", () => {
  const execution = "coordinator:unit:web";
  expect(terminalObserverWorkflowId(execution)).toBe("coordinator:unit:web:terminal");
  expect(gateRelayWorkflowId(execution, artifact)).toBe("coordinator:unit:web:gate:artifact-1");
  expect(handoffWorkflowId(execution, artifact)).toBe("coordinator:unit:web:handoff:artifact-1");
  expect(executorFenceWorkflowId("canceller", "execution-1" as ExecutionId)).toBe("canceller:fence:execution-1");
});

/**
 * The gate wait is addressed two ways: the operator surface builds it from the
 * execution, and the gate relay builds it from inside itself. A command sent to
 * one form and awaited on the other is silently never delivered, so the two
 * spellings have to agree exactly.
 */
test("a gate wait is the same workflow whether named from the execution or from its relay", () => {
  const execution = "coordinator:unit:web";
  expect(gateWaitWorkflowId(execution, artifact, "artifact_approval"))
    .toBe(gateWaitWorkflowIdFromRelay(gateRelayWorkflowId(execution, artifact), "artifact_approval"));
});

/**
 * Two projections match these IDs in SQL, where no type can check them. The
 * exported affixes are what the builders themselves concatenate, so the SQL and
 * the workflows cannot drift apart.
 */
test("the affixes the SQL concatenates are the ones the builders use", () => {
  const execution = "coordinator:unit:web";
  expect(`${execution}${TERMINAL_OBSERVER_SUFFIX}`).toBe(terminalObserverWorkflowId(execution));
  expect(`${execution}${HANDOFF_INFIX}${artifact}`).toBe(handoffWorkflowId(execution, artifact));
});

// Not revision-scoped, the replacement would be deduplicated by DBOS onto the
// execution that already finished, and the relaunched unit would never move.
test("a unit relaunched onto a revised input is named off the revising artifact", () => {
  const coordinator = stageCoordinatorWorkflowId(root, "assessor");
  expect(unitRevisionExecutionWorkflowId(coordinator, "web" as UnitId, artifact))
    .toBe("oakridge-run:run-1:attempt:initial:stage:assessor:unit:web:revision:artifact-1");
  expect(unitRevisionExecutionWorkflowId(coordinator, "web" as UnitId, artifact))
    .not.toBe(unitExecutionWorkflowId(coordinator, "web" as UnitId));
});

test("each revision of the same unit gets its own execution, and the same revision does not get two", () => {
  const coordinator = stageCoordinatorWorkflowId(root, "assessor");
  const first = unitRevisionExecutionWorkflowId(coordinator, "web" as UnitId, "artifact-2" as ArtifactId);
  const second = unitRevisionExecutionWorkflowId(coordinator, "web" as UnitId, "artifact-3" as ArtifactId);
  expect(first).not.toBe(second);
  expect(unitRevisionExecutionWorkflowId(coordinator, "web" as UnitId, "artifact-2" as ArtifactId)).toBe(first);
});
