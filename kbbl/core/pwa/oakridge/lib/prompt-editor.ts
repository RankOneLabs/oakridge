import type { OperatorDefinitionDetail, OperatorDefinitionPrompt } from "../operator-contracts/projections/definition-view";
import type { OperatorPromptVersionListing, OperatorPromptVersionView, OperatorPromptPublicationOutcome } from "../operator-contracts/http/prompt-versions";
import { selectStageInspector } from "./stage-inspector";
import { selectPromptRows } from "./prompt-inspector";

export interface PromptDraftState {
  path: string; published_body: string; published_digest: string; body: string; is_dirty: boolean;
  pending: { digest: string; body: string } | null;
}
export type PromptFeedback =
  | { kind: "saving" | "validating" | "validated" | "publishing" | "conflict" }
  | { kind: "saved"; digest: string }
  | { kind: "published"; definition_id: string | null }
  | { kind: "validation_failed"; issues: readonly { path: readonly (string | number)[]; detail: string }[] }
  | { kind: "transport_error"; detail: string };
export function createPromptDraft({path, published, versions}: {path: string; published: OperatorDefinitionPrompt; versions: OperatorPromptVersionListing}): PromptDraftState {
  return {path, published_body: published.body, published_digest: published.digest, body: versions.pending?.body ?? published.body, is_dirty: false,
    pending: versions.pending ? {digest: versions.pending.version_id, body: versions.pending.body} : null};
}
export const editPromptBody = (state: PromptDraftState, body: string): PromptDraftState => ({...state, body, is_dirty: body !== (state.pending?.body ?? state.published_body)});
export const pendingSaved = (state: PromptDraftState, version: OperatorPromptVersionView): PromptDraftState => ({...state, body: version.body, pending: {digest: version.version_id, body: version.body}, is_dirty: false});
export const discardLocalEdits = (state: PromptDraftState): PromptDraftState => ({...state, body: state.pending?.body ?? state.published_body, is_dirty: false});
export const promptPublished = (state: PromptDraftState, digest: string): PromptDraftState => ({...state, published_body: state.pending?.body ?? state.body, published_digest: digest, pending: null, is_dirty: false});
export function selectPromptEditorActions(state: PromptDraftState, is_busy: boolean) {
  return {save: !is_busy && state.is_dirty, validate: !is_busy && !state.is_dirty && state.pending !== null,
    publish: !is_busy && !state.is_dirty && state.pending !== null, discard: !is_busy && state.is_dirty, close: !is_busy};
}
export function promptFeedbackText(feedback: PromptFeedback): string {
  switch (feedback.kind) {
    case "saving": return "Saving pending version…";
    case "saved": return `Pending version saved · ${feedback.digest}`;
    case "validating": return "Validating pending version…";
    case "validated": return "Pending version is valid.";
    case "validation_failed": return "Validation failed. Review the issues below.";
    case "publishing": return "Publishing prompt…";
    case "published": return feedback.definition_id ? `Published · new definition ${feedback.definition_id.slice(0, 12)}` : "Published";
    case "conflict": return "Conflict: the prompt changed since it was read. Your local edits are preserved. Reload before retrying.";
    case "transport_error": return `Request failed: ${feedback.detail}`;
  }
}
export interface PromptReference {
  definition_id: string; workflow: string; stage: string; owner_kind: "worker" | "review"; owner_key: string; mode: string; template: string | null;
}
export function selectPromptReferences({path, definitions}: {path: string; definitions: readonly OperatorDefinitionDetail[]}): PromptReference[] {
  return definitions.flatMap(definition => !definition.prompts[path] ? [] : Object.keys(definition.effective_workflow.stages).flatMap(stage => {
    const model = selectStageInspector(definition, {kind: "stage", stage, tab: null});
    return model ? selectPromptRows(model).filter(row => row.path === path).map(row => ({
      definition_id: definition.definition_id, workflow: definition.bundle.key, stage, owner_kind: row.owner.kind,
      owner_key: row.owner.key, mode: row.mode, template: row.owner.template,
    })) : [];
  })).sort((a, b) => a.workflow.localeCompare(b.workflow) || a.stage.localeCompare(b.stage) || a.owner_key.localeCompare(b.owner_key) || a.mode.localeCompare(b.mode));
}
export const selectPromptIsShared = (references: readonly PromptReference[]): boolean => references.length > 1 || references.some(reference => reference.template !== null);
export const selectPublishedDefinitionId = (outcome: OperatorPromptPublicationOutcome, workflow: string): string | null => outcome.moved.find(move => move.workflow === workflow)?.definition_id ?? null;
