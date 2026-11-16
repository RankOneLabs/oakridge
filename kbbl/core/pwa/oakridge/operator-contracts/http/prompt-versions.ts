// Generated from oakridge-dbos/src/http/operator-api.ts. Run bun kbbl/scripts/generate-operator-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

import type { OperatorDefinitionId, OperatorPromptId, OperatorPromptVersionId, OperatorPromptVersionObject, OperatorWorkflowAudience } from "../runtime/definition-store";

export interface OperatorPromptVersionView extends OperatorPromptVersionObject { readonly version_id: OperatorPromptVersionId; readonly body: string; readonly status: "published" | "pending" | "superseded"; readonly published_at: string | null }

export interface OperatorPromptVersionListing { readonly source_path: string; readonly published: OperatorPromptVersionView; readonly pending: OperatorPromptVersionView | null; readonly versions: readonly OperatorPromptVersionView[]; readonly referenced_by: readonly OperatorPromptReference[] }

export interface OperatorPromptValidationOutcome { readonly valid: true; readonly workflows: readonly string[] }

export interface OperatorPromptPublicationOutcome { readonly version_id: OperatorPromptVersionId; readonly prompt_id: OperatorPromptId; readonly source_path: string; readonly published_at: string; readonly moved: readonly OperatorPromptMove[] }

export interface OperatorPromptVersionError { readonly operation: "prompt_versions"; readonly kind: OperatorPromptVersionErrorKind; readonly entity_id: string; readonly detail: string; readonly issues: readonly OperatorPromptIssue[] }

export type OperatorPromptVersionErrorKind = "invalid_path" | "unknown_prompt" | "invalid_prompt" | "pending_conflict" | "published_conflict" | "no_pending" | "inconsistent_published_prompt" | "store_io";

export interface OperatorPromptIssue { readonly workflow: string; readonly path: readonly string[]; readonly detail: string }

export interface OperatorSavePendingPromptRequest extends OperatorValidatePromptRequest { readonly expected_pending_version_id: OperatorPromptVersionId | null }

export interface OperatorValidatePromptRequest { readonly path: string; readonly body: string }

export interface OperatorPublishPromptRequest { readonly path: string; readonly expected_pending_version_id: OperatorPromptVersionId; readonly expected_published_version_id: OperatorPromptVersionId }

export interface OperatorPromptReference { readonly workflow: string; readonly workflow_name: string; readonly definition_id: OperatorDefinitionId }

export interface OperatorPromptMove extends OperatorPromptReference { readonly audience: OperatorWorkflowAudience; readonly previous_definition_id: OperatorDefinitionId }
