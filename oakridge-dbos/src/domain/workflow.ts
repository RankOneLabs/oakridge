import type { StageInstanceId, WorkflowRunId } from "./primitives";

export type StageKey = string;
export type StageTypeId = string;
export type ArtifactTypeId = string;
export type InputDelivery = "producer_complete" | "unit_complete";
/**
 * An adapter-owned role name. Core carries this value through configuration
 * and durable records; the adapter registry decides whether it is supported.
 */
export type StageOperatorRole = string;

/** A pinned v15 action-point prompt, persisted in oakridge.prompt_bundle. */
export type PromptBundleEntry = import("./dev-flow-v15").V15PromptEntry;

export interface PromptBundle {
  readonly version: 1;
  readonly hash: string;
  readonly entries: readonly PromptBundleEntry[];
}

/** The immutable versions selected once for a run. */
export interface WorkflowRunBundlePin {
  readonly definition_version: number;
  readonly prompt_bundle_hash: string;
  readonly adapter_version: string;
  readonly artifact_schema_version: string;
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
