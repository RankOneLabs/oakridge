// Generated from oakridge-dbos/src/http/operator-api.ts. Run bun kbbl/scripts/generate-operator-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

export interface OperatorPromptVersionObject { readonly prompt_id: string; readonly source_path: string }

export type OperatorWorkflowAudience = "user" | "test_fixture";
