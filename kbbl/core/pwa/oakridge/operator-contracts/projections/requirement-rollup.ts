// Generated from oakridge-dbos/src/http/operator-api.ts. Run bun kbbl/scripts/generate-operator-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

export interface OperatorRequirementRollup {
  readonly requirement_id: string; readonly status: "pending" | "judged";
  readonly repositories: readonly OperatorRepositoryRequirementJudgment[];
}

export type OperatorRepositoryRequirementJudgment =
  | { readonly repository_key: string; readonly status: "met" | "partial" | "not_met"; readonly revision_id: string; readonly head_sha: string }
  | { readonly repository_key: string; readonly status: "pending"; readonly revision_id: null; readonly head_sha: null };
