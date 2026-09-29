import type { JsonValue, StageInstanceId, WorkflowDefinitionId, WorkflowRunId } from "./primitives";
import type { OutputAttention } from "./compiled-workflow";
import type { PromptMatrixEntry } from "./delegated-session";

export type StageKey = string;
export type StageTypeId = string;
export type ArtifactTypeId = string;
export type InputDelivery = "producer_complete" | "unit_complete";
/**
 * An adapter-owned role name. Core carries this value through configuration
 * and durable records; the adapter registry decides whether it is supported.
 */
export type StageOperatorRole = string;

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
  readonly attention?: OutputAttention;
}

export interface EdgeEndpoint { readonly stage: StageKey; readonly slot: string }
export interface Edge { readonly from: EdgeEndpoint; readonly to: EdgeEndpoint }
export interface WorkflowTransition {
  readonly trigger: { readonly kind: "stage_output" | "assessment_outcome" | "operator"; readonly stage: StageKey; readonly item: string };
  readonly launch: { readonly stage: StageKey; readonly session_role: StageOperatorRole; readonly launch_reason: import("./delegated-session").SessionLaunchReasonName };
}

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
  readonly transitions?: readonly WorkflowTransition[];
}

export interface WorkflowDefinition {
  readonly id: WorkflowDefinitionId;
  readonly name: string;
  readonly version: number;
  readonly graph: WorkflowGraph;
  readonly created_at: string;
  readonly archived: boolean;
}

export interface PromptBundleEntry extends PromptMatrixEntry {
  /** Stage identity prevents equal role/reason cells in different stages from colliding. */
  readonly stage_key?: StageKey;
  readonly content: string;
}
export interface PromptBundle {
  readonly version: 1;
  readonly hash: string;
  readonly matrix: readonly PromptBundleEntry[];
}

/** The immutable versions selected once for a run. */
export interface WorkflowRunBundlePin {
  readonly definition_version: number;
  readonly prompt_bundle_hash: string;
  readonly adapter_version: string;
  readonly artifact_schema_version: string;
}

export interface CreateWorkflowDefinition {
  readonly name: string;
  readonly version: number;
  readonly graph: WorkflowGraph;
}

export type StageOutcome =
  | { readonly kind: "succeeded" }
  | { readonly kind: "failed"; readonly code: string; readonly detail: string }
  | { readonly kind: "cancelled"; readonly reason: string | null };

/** A stage outcome that ends the run it belongs to. */
export type StageFailureOutcome = Exclude<StageOutcome, { readonly kind: "succeeded" }>;

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
