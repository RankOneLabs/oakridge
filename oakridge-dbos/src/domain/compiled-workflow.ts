import type { JsonValue, UnitId } from "./primitives";
import type { ArtifactTypeId, InputDelivery, StageKey, StageOperatorRole, StageTypeId, WorkflowRunBundlePin } from "./workflow";
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
  readonly attention?: OutputAttention;
  readonly release: OutputReleaseContract;
}

export interface CompiledGateStep { readonly type: string; readonly actions: readonly GateAction[] }

export type OutputReleaseContract =
  | { readonly kind: "immediate" }
  | { readonly kind: "gate"; readonly gate_name: string; readonly steps: readonly CompiledGateStep[]; readonly requires_zero_open_review_items: boolean }
  | { readonly kind: "handoff"; readonly handoff_name: string; readonly downstream_role: StageOperatorRole; readonly external_wait_kind: string; readonly close_events: readonly string[] };

export type OutputAttention = "required" | "optional" | "none";
export type OutputContinuation = "waiting" | "continuing";

/** Derive the operator attention implied by an output's release contract. */
export const selectOutputAttention = (
  output: Pick<CompiledOutputContract, "attention" | "release">,
): OutputAttention => output.attention ?? (output.release.kind === "gate"
  ? "required"
  : output.release.kind === "handoff" && output.release.external_wait_kind.length > 0
    ? "optional"
    : "none");

export type MaterializationContract =
  | { readonly kind: "scalar" }
  | { readonly kind: "artifact_collections"; readonly productions: readonly { readonly over: SlotBinding; readonly id_path: string }[] }
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

export interface CompiledTransition {
  readonly trigger: { readonly kind: "stage_output" | "assessment_outcome" | "operator"; readonly stage: StageKey; readonly item: string };
  readonly launch: { readonly stage: StageKey; readonly session_role: StageOperatorRole; readonly launch_reason: import("./delegated-session").SessionLaunchReasonName };
}

export interface CompiledWorkflowDefinition {
  readonly manifest_version: 1;
  readonly bundle_pin?: WorkflowRunBundlePin;
  /** Policy findings preserved for operator review without making the definition structurally invalid. */
  readonly flags?: readonly { readonly kind: "automated_assessment_transition"; readonly stage_key: StageKey;
    readonly session_role: StageOperatorRole | null; readonly contract_item: string; readonly trigger: string }[];
  readonly stages: Readonly<Record<StageKey, CompiledStageContract>>;
  readonly edges: readonly CompiledEdge[];
  /** Named revision and retry routes retained for the decision runtime. */
  readonly transitions: readonly CompiledTransition[];
  readonly source_stages: readonly StageKey[];
}

export interface MaterializedExecutionUnit {
  readonly unit_id: UnitId;
  readonly parameters: JsonValue;
  readonly depends_on: readonly UnitId[];
}
