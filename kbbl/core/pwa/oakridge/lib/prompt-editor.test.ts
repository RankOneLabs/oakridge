import { expect, test } from "vitest";
import fixture from "../__fixtures__/v2-definition-detail.json";
import type { OperatorDefinitionDetail } from "../operator-contracts/projections/definition-view";
import type { OperatorPromptVersionListing, OperatorPromptPublicationOutcome } from "../operator-contracts/http/prompt-versions";
import { createPromptDraft, editPromptBody, pendingSaved, discardLocalEdits, selectPromptEditorActions, selectPromptReferences, selectPromptIsShared, selectPublishedDefinitionId, promptFeedbackText, type PromptFeedback } from "./prompt-editor";
const definition = fixture.definition as unknown as OperatorDefinitionDetail;
const published = {version_id: "old", prompt_id: "prompt", source_path: "development/brief.md", body: "published", status: "published" as const, published_at: "now"};
const versions: OperatorPromptVersionListing = {source_path: published.source_path, published, pending: null, versions: [published], referenced_by: []};
const draft = () => createPromptDraft({path: published.source_path, published: {body: published.body, digest: "old"}, versions});
test("draft seeds published or saved pending body without local changes", () => {
  expect(draft()).toMatchObject({body: "published", is_dirty: false});
  expect(createPromptDraft({path: published.source_path, published: {body: "published", digest: "old"}, versions: {...versions, pending: {...published, body: "pending", status: "pending"}}})).toMatchObject({body: "pending", is_dirty: false});
});
test("editing, saving and discarding preserve the last saved body", () => {
  const edited = editPromptBody(draft(), "local");
  expect(edited.is_dirty).toBe(true);
  const saved = pendingSaved(edited, {...published, version_id: "saved", body: "local", status: "pending"});
  expect(saved).toMatchObject({is_dirty: false, pending: {digest: "saved"}});
  expect(discardLocalEdits(editPromptBody(saved, "other")).body).toBe("local");
  expect(discardLocalEdits(edited).body).toBe("published");
});
test("actions require saved pending content and disable all operations when busy", () => {
  expect(selectPromptEditorActions(draft(), false)).toMatchObject({save: false, validate: false, publish: false});
  expect(selectPromptEditorActions(editPromptBody(draft(), "new"), false)).toMatchObject({save: true, validate: false, publish: false, discard: true});
  const saved = pendingSaved(draft(), published);
  expect(selectPromptEditorActions(saved, false)).toMatchObject({save: false, validate: true, publish: true});
  expect(Object.values(selectPromptEditorActions(saved, true)).every(value => !value)).toBe(true);
});
test("references include both shared review uses and the sole brief writer", () => {
  const references = selectPromptReferences({path: "development/merge-confirmation.md", definitions: [definition]});
  expect(references.map(({stage, owner_key, mode}) => ({stage, owner_key, mode}))).toEqual([
    {stage: "cohort", owner_key: "merge_confirmation", mode: "review"},
    {stage: "integration", owner_key: "merge_confirmation", mode: "review"},
  ]);
  expect(selectPromptIsShared(references)).toBe(true);
  const brief = selectPromptReferences({path: "development/brief.md", definitions: [definition]});
  expect(brief).toMatchObject([{owner_key: "writer", mode: "initial"}]);
  expect(selectPromptIsShared(brief)).toBe(false);
});
test("template provenance survives reference selection", () => {
  const worker = {template: "shared_builder"};
  const templated: OperatorDefinitionDetail = {...definition, workflow: {...definition.workflow,
    stages: {...definition.workflow.stages, cohort: {...definition.workflow.stages.cohort,
      workers: {...definition.workflow.stages.cohort.workers, builder: worker}}}}};
  const references = selectPromptReferences({path: "development/build.md", definitions: [templated]});
  expect(references.find(reference => reference.stage === "cohort" && reference.owner_key === "builder")?.template).toBe(worker.template);
});
test("publication selects only the viewed workflow's reported id", () => {
  const outcome: OperatorPromptPublicationOutcome = {version_id: "v", prompt_id: "p", source_path: "p", published_at: "now", moved: [{workflow: "development", workflow_name: "Development", definition_id: "new", previous_definition_id: "old", audience: "user"}]};
  expect(selectPublishedDefinitionId(outcome, "development")).toBe("new");
  expect(selectPublishedDefinitionId(outcome, "missing")).toBeNull();
});
test.each<[PromptFeedback, string]>([
  [{kind: "saving"}, "Saving pending version…"], [{kind: "saved", digest: "abc"}, "Pending version saved · abc"],
  [{kind: "validating"}, "Validating pending version…"], [{kind: "validated"}, "Pending version is valid."],
  [{kind: "validation_failed", issues: []}, "Validation failed. Review the issues below."],
  [{kind: "publishing"}, "Publishing prompt…"], [{kind: "published", definition_id: "123456789012345"}, "Published · new definition 123456789012"],
  [{kind: "conflict"}, "Conflict: the prompt changed since it was read. Your local edits are preserved. Reload before retrying."],
  [{kind: "transport_error", detail: "offline"}, "Request failed: offline"],
])("feedback copy for %j", (feedback, text) => expect(promptFeedbackText(feedback)).toBe(text));
