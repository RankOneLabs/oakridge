// Generated from oakridge-dbos/src/http/operator-api.ts. Run bun kbbl/scripts/generate-operator-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

export type OperatorDefinitionId = string & { readonly __brand: "DefinitionId" };

export interface OperatorPromptVersionObject { readonly prompt_id: OperatorPromptId; readonly source_path: string }

export type OperatorPromptVersionId = string & { readonly __brand: "PromptVersionId" };

export type OperatorPromptId = string & { readonly __brand: "PromptId" };

export type OperatorWorkflowAudience = "user" | "test_fixture";
