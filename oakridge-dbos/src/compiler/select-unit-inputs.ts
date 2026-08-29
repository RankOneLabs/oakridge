import type { CompiledStageContract, MaterializedExecutionUnit } from "../domain/compiled-workflow";
import type { ArtifactEnvelope } from "../domain/execution";

export interface StageInputSet {
  readonly [input_name: string]: ArtifactEnvelope | readonly ArtifactEnvelope[];
}

/** Selects the declared per-unit inputs without coupling the transform to a workflow. */
export const selectInputsForUnit = (stage: CompiledStageContract, inputs: StageInputSet, unit: MaterializedExecutionUnit): StageInputSet => {
  if (stage.materialization.kind !== "fan_out") return inputs;
  const perUnit = new Set(stage.inputs.filter((input) => input.delivery === "unit_complete").map((input) => input.name));
  return Object.fromEntries(Object.entries(inputs).map(([name, value]) =>
    Array.isArray(value) && perUnit.has(name) ? [name, value.filter((artifact) => artifact.unit_id === unit.unit_id)] : [name, value]));
};
