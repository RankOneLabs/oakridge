// Generated from observation/src/http/grading-api.ts. Run bun kbbl/scripts/generate-grading-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

export type ObservationRunStageRead = ObservationWorkflowStage & ObservationStageState;

export interface ObservationWorkflowStage { readonly stage: string; readonly artifact_kinds: readonly string[] }

export type ObservationStageState =
  | { readonly state: "not_graded" }
  | { readonly state: "pending" }
  | { readonly state: "gap" }
  | { readonly state: "linked" };
