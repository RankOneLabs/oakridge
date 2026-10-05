import type { JsonValue } from "./types";
/** Envelope of /workflow_defs. Semantic checking is performed by the backend compiler. */
export interface WorkflowDefinitionDescriptor {
  readonly key: string; readonly version: number;
  readonly stages: { readonly [key: string]: WorkflowStageDescriptor };
}
export interface WorkflowStageDescriptor {
  readonly prerequisites: readonly string[]; readonly max_active_cohorts: number;
  readonly cohort: { readonly workers: { readonly [key: string]: JsonValue }; readonly decision_tree: JsonValue };
}
