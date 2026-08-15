import { expect, test } from "bun:test";
import { materializeIncrementalArtifact, materializeStage } from "../src/compiler/materialize-stage";
import type { CompiledStageContract } from "../src/domain/compiled-workflow";
import type { ArtifactId, UnitId } from "../src/domain/primitives";

const stage = (materialization: CompiledStageContract["materialization"]): CompiledStageContract => ({ stage_key: "build", stage_type: "delegated_session", operator_role: "build", inputs: [], outputs: [], materialization, executor: { executor_type: "delegated_session", definition_config: {} } });

test("production stage materialization obtains runtime N only from its bound input", () => {
  const result = materializeStage(stage({ kind: "fan_out", over: { from: "input", input_name: "brief" }, unit_id_path: "/unit_id", depends_on_path: "/artifact/depends_on", max_parallel: 4, manual_admission: false }), {
    inputs: { brief: [
      { artifact_id: "a" as ArtifactId, artifact_type: "dev.build_brief", output_name: "brief", unit_id: "foundation" as UnitId, body: { depends_on: [] } },
      { artifact_id: "b" as ArtifactId, artifact_type: "dev.build_brief", output_name: "brief", unit_id: "web" as UnitId, body: { depends_on: ["foundation"] } },
    ] }, context: {}, item: null,
  });
  expect(result).toEqual({ ok: true, value: [expect.objectContaining({ unit_id: "foundation", depends_on: [] }), expect.objectContaining({ unit_id: "web", depends_on: ["foundation"] })] });
});

test("incremental delivery preserves source unit correlation without counting siblings", () => {
  const result = materializeIncrementalArtifact(stage({ kind: "fan_out", over: { from: "input", input_name: "build_result" }, unit_id_path: "/unit_id", depends_on_path: null, max_parallel: 4, manual_admission: false }), {
    artifact_id: "artifact-1" as ArtifactId, artifact_type: "dev.build_result", output_name: "build_result", unit_id: "web" as UnitId,
    body: { summary: "done" },
  });
  expect(result).toEqual({ ok: true, value: expect.objectContaining({ unit_id: "web", depends_on: [], parameters: { unit_id: "web", artifact: { summary: "done" } } }) });
});
