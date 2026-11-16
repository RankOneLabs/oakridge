import { API, OPERATOR } from "./client-http";
import type { OperatorPromptVersionListing, OperatorPromptVersionView, OperatorPromptValidationOutcome, OperatorPromptPublicationOutcome, OperatorPromptVersionError, OperatorSavePendingPromptRequest, OperatorPublishPromptRequest, OperatorValidatePromptRequest } from "./operator-contracts/http/prompt-versions";
import type { PromptFeedback } from "./lib/prompt-editor";
export type PromptVersionResult<T> = {ok: true; value: T} | {ok: false; feedback: PromptFeedback};
const root = `${OPERATOR}/prompt-versions`;
// The shared HTTP helpers flatten errors to text. Preserve the store's typed issues here.
async function request<T>(path: string, method = "GET", payload?: OperatorSavePendingPromptRequest | OperatorPublishPromptRequest | OperatorValidatePromptRequest): Promise<PromptVersionResult<T>> {
  try {
    const response = await fetch(API + path, {method, ...(payload ? {headers: {"Content-Type": "application/json", "X-Oakridge-Publisher": "operator"}, body: JSON.stringify(payload)} : {})});
    const body = await response.json() as T | {error: OperatorPromptVersionError};
    if (response.ok) return {ok: true, value: body as T};
    const error = (body as {error?: OperatorPromptVersionError})?.error;
    if (error?.kind === "pending_conflict" || error?.kind === "published_conflict") return {ok: false, feedback: {kind: "conflict"}};
    if (error?.kind === "invalid_prompt") return {ok: false, feedback: {kind: "validation_failed", issues: error.issues}};
    return {ok: false, feedback: {kind: "transport_error", detail: error?.detail ?? `Unexpected response (${response.status})`}};
  } catch (cause) { return {ok: false, feedback: {kind: "transport_error", detail: cause instanceof Error ? cause.message : String(cause)}}; }
}
export const readPromptVersions = (path: string) => request<OperatorPromptVersionListing>(`${root}?path=${encodeURIComponent(path)}`);
export const savePendingPrompt = ({path, body, expected}: {path: string; body: string; expected: OperatorSavePendingPromptRequest["expected_pending_version_id"]}) =>
  request<OperatorPromptVersionView>(root + "/pending", "PUT", {path, body, expected_pending_version_id: expected});
export async function validatePendingPrompt(path: string, expected: OperatorPromptVersionView["version_id"]): Promise<PromptVersionResult<OperatorPromptValidationOutcome>> {
  const listing = await readPromptVersions(path);
  if (!listing.ok) return listing;
  if (!listing.value.pending || listing.value.pending.version_id !== expected) return {ok: false, feedback: {kind: "conflict"}};
  return request(root + "/validate", "POST", {path, body: listing.value.pending.body});
}
export const publishPrompt = ({path, expected}: {path: string; expected: Omit<OperatorPublishPromptRequest, "path">}) =>
  request<OperatorPromptPublicationOutcome>(root + "/publish", "POST", {path, ...expected});
