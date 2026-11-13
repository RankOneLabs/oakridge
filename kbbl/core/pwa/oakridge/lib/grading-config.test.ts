import { describe, expect, it } from "vitest";
import { configurationDiff, configurationHeader, createDraft, definitionSummaries, editDraft, parseDefinitions, publicationFailure, publicationFeedback, saveFailed, saveSucceeded, sectionIssues } from "./grading-config";
import type { ObservationPublicationError } from "../grading-contracts/grading/publication";

import type { ObservationJsonValue } from "../grading-contracts/domain/primitives";

const definitions: readonly ObservationJsonValue[] = [{ id: "quality", scope: "per_item", targets: [{ artifact: "finding", selector: "/items" }], evidence: ["source", { capability: "code", params: {} }], question: { text: "Useful?", values: [true, false] }, evaluators: [{ runner: "llm_judge", model: "test" }, { runner: "human" }] }];
describe("the shared grading draft", () => {
  it("edits a nested path without changing the base document or concurrency tokens", () => {
    const state = createDraft({ document: { status: "draft", definitions }, digest: "base" }, 4);
    expect(editDraft(state, [0, "question", "text"], "Clear?")).toMatchObject({ definitions: [{ question: { text: "Clear?" } }], dirty: true, baseDigest: "base", latestVersionSeen: 4 });
    expect(state.definitions).toEqual(definitions);
  });
  it("preserves every local edit and dirty flag on failure, clears dirty only on a successful save", () => {
    const edited = editDraft(createDraft(null, null), [0, "id"], "new");
    expect(saveFailed(edited)).toBe(edited);
    expect(saveSucceeded(edited, { digest: "next", document: { status: "draft", definitions: edited.definitions } })).toEqual({ ...edited, dirty: false, baseDigest: "next" });
  });
  it("summarizes definitions identically for published and draft JSON", () => {
    expect(definitionSummaries(definitions)).toEqual([{ index: 0, id: "quality", scope: "per_item", targets: [{ artifact: "finding", selector: "/items" }], evidence: ["source", "code"], text: "Useful?", allowedValues: "[true,false]", evaluators: [{ runner: "llm_judge", model: "test" }, { runner: "human", model: "" }] }]);
  });
  it("selects absent, saved and unsaved header status", () => {
    expect(configurationHeader(createDraft(null, null), null).draft).toBe("No draft");
    expect(configurationHeader(createDraft({ digest: "d", document: { status: "draft", definitions } }, 1), null).draft).toBe("Saved draft");
    expect(configurationHeader(editDraft(createDraft(null, null), [0], {}), null).draft).toBe("Unsaved local edits");
  });
  it("compares added, removed and changed values by definition and field path", () => {
    expect(configurationDiff([{ id: "old", removed: true }], [{ id: "new", added: 7 }])).toEqual([
      { kind: "changed", path: [0, "id"], before: "old", after: "new" }, { kind: "removed", path: [0, "removed"], before: true, after: undefined }, { kind: "added", path: [0, "added"], before: undefined, after: 7 },
    ]);
  });
  it("matches service issue paths including the definition index", () => {
    const issue = { definition_index: 2, path: [2, "evaluators", 0, "instructions"], detail: "Bad recipe" };
    expect(sectionIssues([issue], 2, ["evaluators"])).toEqual([issue]);
    expect(sectionIssues([issue], 1, ["evaluators"])).toEqual([]);
    expect(sectionIssues([issue], 2, ["question"])).toEqual([]);
  });
  it("retains malformed raw text outside the JSON draft and accepts schema-invalid JSON arrays", () => {
    expect(parseDefinitions("[").ok).toBe(false);
    expect(parseDefinitions("{}").ok).toBe(false);
    expect(parseDefinitions('[null, {"unknown": true}]')).toEqual({ ok: true, value: [null, { unknown: true }] });
  });
  it.each(["published", "unchanged", "reapplied"] as const)("maps confirmed %s", (outcome) => {
    expect(publicationFeedback({ outcome, version: 2, hash: "h", published_at: "today" })).toEqual({ kind: outcome, version: 2, hash: "h" });
  });
  it.each<readonly [object, object]>([
    [{ kind: "invalid_configuration", issues: [] }, { kind: "validation_failed", issues: [] }],
    [{ kind: "draft_conflict", current_digest: null }, { kind: "conflict", target: "draft" }],
    [{ kind: "version_conflict", current_latest_version: 2 }, { kind: "conflict", target: "version" }],
    [{ kind: "unconfigured_credential", restart_required: true }, { kind: "restart_required", detail: "detail" }],
    ...(["registration_failed", "persistence_failed", "runtime_apply_failed"] as const).map((kind) => [{ kind }, { kind: "runtime_failed", failure: kind, detail: "detail" }] as const),
  ])("maps a publication refusal distinctly", (error, expected) => {
    expect(publicationFailure({ ...error, operation: "grading_publication", entity_id: "draft", detail: "detail" } as ObservationPublicationError)).toEqual(expected);
  });
});
