// Generated from observation/src/http/grading-api.ts. Run bun kbbl/scripts/generate-grading-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

export type ObservationGraderCapability =
  | { readonly state: "none_configured" }
  | { readonly state: "configured"; readonly graders: readonly ObservationConfiguredGrader[] };

export interface ObservationConfiguredGrader { readonly runner: string; readonly evaluator_definition_id: string }
