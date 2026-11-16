import type { PromptVersionId, PromptId, DefinitionId, WorkflowAudience, PromptVersionObject } from "../runtime/definition-store";
import type { Hono } from "hono";
import type { CoreClient } from "../core-client/client";
import { listPromptVersions, savePendingPrompt, validatePrompt, publishPrompt } from "../runtime/prompt-versions";

export interface PromptIssue { readonly workflow: string; readonly path: readonly string[]; readonly detail: string }
export type PromptVersionErrorKind = "invalid_path" | "unknown_prompt" | "invalid_prompt" | "pending_conflict" | "published_conflict" | "no_pending" | "inconsistent_published_prompt" | "store_io";
export interface PromptVersionError { readonly operation: "prompt_versions"; readonly kind: PromptVersionErrorKind; readonly entity_id: string; readonly detail: string; readonly issues: readonly PromptIssue[] }
export interface ValidatePromptRequest { readonly path: string; readonly body: string }
export interface SavePendingPromptRequest extends ValidatePromptRequest { readonly expected_pending_version_id: PromptVersionId | null }
export interface PublishPromptRequest { readonly path: string; readonly expected_pending_version_id: PromptVersionId; readonly expected_published_version_id: PromptVersionId }
export interface PromptVersionView extends PromptVersionObject { readonly version_id: PromptVersionId; readonly body: string; readonly status: "published" | "pending" | "superseded"; readonly published_at: string | null }
export interface PromptReference { readonly workflow: string; readonly workflow_name: string; readonly definition_id: DefinitionId }
export interface PromptVersionListing { readonly source_path: string; readonly published: PromptVersionView; readonly pending: PromptVersionView | null; readonly versions: readonly PromptVersionView[]; readonly referenced_by: readonly PromptReference[] }
export interface PromptValidationOutcome { readonly valid: true; readonly workflows: readonly string[] }
export interface PromptMove extends PromptReference { readonly audience: WorkflowAudience; readonly previous_definition_id: DefinitionId }
export interface PromptPublicationOutcome { readonly version_id: PromptVersionId; readonly prompt_id: PromptId; readonly source_path: string; readonly published_at: string; readonly moved: readonly PromptMove[] }

export function promptErrorStatus(error: PromptVersionError): 400 | 404 | 409 | 422 | 500 {
  switch (error.kind) {
    case "invalid_path": return 400;
    case "unknown_prompt": return 404;
    case "invalid_prompt": return 422;
    case "store_io": return 500;
    default: return 409;
  }
}
export function installPromptVersions(app: Hono, core: CoreClient): void {
  app.get("/api/prompt-versions", context => {
    const result = listPromptVersions(context.req.query("path") ?? "");
    return result.ok ? context.json(result.value) : context.json({ error: result.error }, promptErrorStatus(result.error));
  });
  app.put("/api/prompt-versions/pending", async context => {
    try {
      const request = await context.req.json<SavePendingPromptRequest>();
      const result = await savePendingPrompt(request);
      return result.ok ? context.json(result.value) : context.json({ error: result.error }, promptErrorStatus(result.error));
    } catch (cause) { return context.json({ error: { operation: "prompt_versions", kind: "invalid_path", entity_id: "", detail: String(cause), issues: [] } }, 400); }
  });
  app.post("/api/prompt-versions/validate", async context => {
    try {
      const request = await context.req.json<ValidatePromptRequest>();
      const result = await validatePrompt(core, request);
      return result.ok ? context.json(result.value) : context.json({ error: result.error }, promptErrorStatus(result.error));
    } catch (cause) { return context.json({ error: { operation: "prompt_versions", kind: "invalid_path", entity_id: "", detail: String(cause), issues: [] } }, 400); }
  });
  app.post("/api/prompt-versions/publish", async context => {
    try {
      const request = await context.req.json<PublishPromptRequest>();
      const result = await publishPrompt(core, request);
      return result.ok ? context.json(result.value) : context.json({ error: result.error }, promptErrorStatus(result.error));
    } catch (cause) { return context.json({ error: { operation: "prompt_versions", kind: "invalid_path", entity_id: "", detail: String(cause), issues: [] } }, 400); }
  });
}
