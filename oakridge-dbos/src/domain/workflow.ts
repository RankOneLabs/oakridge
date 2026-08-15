import type { JsonValue, StageInstanceId, WorkflowDefinitionId, WorkflowRunId } from "./primitives";

export type StageKey = string;
export type StageTypeId = string;
export type ArtifactTypeId = string;
export type InputDelivery = "producer_complete" | "unit_complete";
export type StageOperatorRole = "spec" | "plan" | "brief" | "build" | "assessment" | "final_integration";

export interface InputSlot {
  readonly name: string;
  readonly artifact_type: ArtifactTypeId;
  readonly optional: boolean;
  readonly collect: boolean;
  readonly delivery: InputDelivery;
}

export interface OutputSlot {
  readonly name: string;
  readonly artifact_type: ArtifactTypeId;
}

export interface EdgeEndpoint { readonly stage: StageKey; readonly slot: string }
export interface Edge { readonly from: EdgeEndpoint; readonly to: EdgeEndpoint }

export interface StageNodeDefinition {
  readonly stage_type: StageTypeId;
  readonly operator_role: StageOperatorRole | null;
  readonly config: JsonValue;
  readonly inputs: readonly InputSlot[];
  readonly outputs: readonly OutputSlot[];
}

export interface WorkflowGraph {
  readonly stages: Readonly<Record<StageKey, StageNodeDefinition>>;
  readonly edges: readonly Edge[];
}

export interface WorkflowDefinition {
  readonly id: WorkflowDefinitionId;
  readonly name: string;
  readonly version: number;
  readonly graph: WorkflowGraph;
  readonly created_at: string;
  readonly archived: boolean;
}

export type StageOutcome =
  | { readonly kind: "succeeded" }
  | { readonly kind: "failed"; readonly code: string; readonly detail: string }
  | { readonly kind: "cancelled"; readonly reason: string | null };

export type StageInstanceLifecycle =
  | { readonly kind: "pending" }
  | { readonly kind: "started"; readonly started_at: string }
  | { readonly kind: "finished"; readonly started_at: string; readonly ended_at: string; readonly outcome: StageOutcome };

export interface StageInstance {
  readonly id: StageInstanceId;
  readonly run_id: WorkflowRunId;
  readonly stage_key: StageKey;
  readonly stage_type: StageTypeId;
  readonly lifecycle: StageInstanceLifecycle;
}
