import { expect, test } from "bun:test";

import type { ArtifactEnvelope, ExecutionRequest } from "../src/domain/execution";
import type { ArtifactId, ExecutionId, StageInstanceId, UnitId } from "../src/domain/primitives";
import { selectRevisionConsumer } from "../src/workflows/production-topology";

const envelope = (id: string, chain: string, unitId: string): ArtifactEnvelope => ({
  artifact_id: id as ArtifactId, chain_id: chain as ArtifactId, artifact_type: "dev.build_result",
  output_name: "build_result", unit_id: unitId as UnitId, body: {},
});

const plan = (unitId: string, inputs: readonly ArtifactEnvelope[]) => ({
  unit: { unit_id: unitId as UnitId, parameters: {}, depends_on: [] },
  request: {
    execution_id: `execution-${unitId}` as ExecutionId, stage_instance_id: "stage-1" as StageInstanceId,
    unit_id: unitId as UnitId, executor_type: "delegated_session", resolved_config: {},
    inputs, declared_outputs: [], expected_artifacts: [],
  } as unknown as ExecutionRequest,
});

test("the unit holding the earlier revision is the one asked to look again", () => {
  const plans = [
    plan("assess-foundation", [envelope("build-v1", "build-chain", "foundation")]),
    plan("assess-web", [envelope("web-v1", "web-chain", "web")]),
  ];
  expect(selectRevisionConsumer(plans, envelope("build-v2", "build-chain", "foundation"))).toBe("assess-foundation" as UnitId);
});

/**
 * The case the previous lookup dropped in silence. A stage whose `unit_id_path`
 * reads out of the artifact body mints units under ids the artifact does not
 * carry — nothing in the compiler forbids it — so matching on unit id found
 * nobody, the revision went nowhere, and the run stalled with no error.
 */
test("a unit minted under an id the artifact does not carry is still found", () => {
  const plans = [plan("cohort-7", [envelope("build-v1", "build-chain", "foundation")])];
  expect(selectRevisionConsumer(plans, envelope("build-v2", "build-chain", "foundation"))).toBe("cohort-7" as UnitId);
});

/**
 * A unit minted before this input arrived cannot mention it in its launch
 * snapshot, so identity falls back to the unit id it shares with the artifact.
 */
test("a unit minted before the input arrived is found by its unit id", () => {
  const plans = [plan("foundation", [])];
  expect(selectRevisionConsumer(plans, envelope("brief-v2", "brief-chain", "foundation"))).toBe("foundation" as UnitId);
});

test("an artifact no unit consumes has no consumer", () => {
  const plans = [plan("assess-web", [envelope("web-v1", "web-chain", "web")])];
  expect(selectRevisionConsumer(plans, envelope("build-v2", "build-chain", "foundation"))).toBeNull();
});
