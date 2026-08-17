import type { JsonValue, UnitId } from "./primitives";
import type { ArtifactTypeId, InputDelivery, StageKey, StageOperatorRole, StageTypeId } from "./workflow";
import type { DelegatedSessionDefinitionConfig, SlotBinding } from "./delegated-session";
import type { GateAction } from "./gates";

export interface CompiledInputContract {
  readonly name: string;
  readonly artifact_type: ArtifactTypeId;
  readonly optional: boolean;
  readonly collect: boolean;
  readonly delivery: InputDelivery;
}

export interface CompiledOutputContract {
  readonly name: string;
  readonly artifact_type: ArtifactTypeId;
  readonly release: OutputReleaseContract;
}

export interface CompiledGateStep { readonly type: string; readonly actions: readonly GateAction[] }

export type OutputReleaseContract =
  | { readonly kind: "immediate" }
  | { readonly kind: "gate"; readonly steps: readonly CompiledGateStep[]; readonly requires_zero_open_review_items: boolean; readonly revision_target: "self_stage" | "upstream_handoff" }
  | { readonly kind: "handoff"; readonly downstream_role: StageOperatorRole; readonly external_wait_kind: string };

export type MaterializationContract =
  | { readonly kind: "scalar" }
  | { readonly kind: "artifact_collection"; readonly over: SlotBinding; readonly id_path: string }
  | { readonly kind: "fan_out"; readonly over: SlotBinding; readonly unit_id_path: string; readonly depends_on_path: string | null; readonly max_parallel: number; readonly manual_admission: boolean };

export interface CompiledExecutorSelection {
  readonly executor_type: StageTypeId;
  readonly definition_config: DelegatedSessionDefinitionConfig | JsonValue;
}

export interface CompiledStageContract {
  readonly stage_key: StageKey;
  readonly stage_type: StageTypeId;
  readonly operator_role: StageOperatorRole | null;
  readonly inputs: readonly CompiledInputContract[];
  readonly outputs: readonly CompiledOutputContract[];
  readonly materialization: MaterializationContract;
  readonly executor: CompiledExecutorSelection;
}

export interface CompiledEdge {
  readonly producer_stage: StageKey;
  readonly producer_output: string;
  readonly consumer_stage: StageKey;
  readonly consumer_input: string;
  readonly delivery: InputDelivery;
}

export interface CompiledWorkflowDefinition {
  readonly stages: Readonly<Record<StageKey, CompiledStageContract>>;
  readonly edges: readonly CompiledEdge[];
  readonly source_stages: readonly StageKey[];
}

export interface MaterializedExecutionUnit {
  readonly unit_id: UnitId;
  readonly parameters: JsonValue;
  readonly depends_on: readonly UnitId[];
}
