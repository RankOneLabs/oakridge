import { materializeBatch } from "./materialize-units";
import { resolveBindingValue, type BindingEnvironment, type ResolveExecutionError } from "./resolve-execution";
import type { CompiledStageContract, MaterializedExecutionUnit } from "../domain/compiled-workflow";
import type { ArtifactEnvelope } from "../domain/execution";
import { err, ok, type Result, type UnitId } from "../domain/primitives";

export interface MaterializeStageError { readonly operation: "materialize_stage"; readonly stage_key: string; readonly detail: string }
const failure = (stage: CompiledStageContract, error: ResolveExecutionError | { readonly detail: string }): Result<never, MaterializeStageError> => err({ operation: "materialize_stage", stage_key: stage.stage_key, detail: error.detail });

export const materializeStage = (stage: CompiledStageContract, environment: BindingEnvironment): Result<readonly MaterializedExecutionUnit[], MaterializeStageError> => {
  if (stage.materialization.kind === "scalar") return ok([{ unit_id: "0" as UnitId, parameters: {}, depends_on: [] }]);
  const over = resolveBindingValue(stage.materialization.over, environment);
  if (!over.ok) return failure(stage, over.error);
  if (!Array.isArray(over.value)) return failure(stage, { detail: `${stage.materialization.kind}.over must resolve to an array` });
  if (stage.materialization.kind === "artifact_collection") {
    return ok([{ unit_id: "0" as UnitId, parameters: over.value, depends_on: [] }]);
  }
  const materialized = materializeBatch(over.value, { unit_id_path: stage.materialization.unit_id_path, depends_on_path: stage.materialization.depends_on_path });
  return materialized.ok ? materialized : failure(stage, materialized.error);
};

export const materializeIncrementalArtifact = (stage: CompiledStageContract, artifact: ArtifactEnvelope): Result<MaterializedExecutionUnit, MaterializeStageError> => {
  if (stage.materialization.kind !== "fan_out") return failure(stage, { detail: "incremental artifact requires fan-out materialization" });
  const parameters = { unit_id: artifact.unit_id, artifact: artifact.body } as const;
  const materialized = materializeBatch([parameters], { unit_id_path: stage.materialization.unit_id_path, depends_on_path: stage.materialization.depends_on_path });
  if (!materialized.ok) return failure(stage, materialized.error);
  const unit = materialized.value[0];
  return unit ? ok(unit) : failure(stage, { detail: "incremental materialization returned no unit" });
};
