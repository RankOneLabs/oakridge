import { expect, test } from "vitest";
import type { ArtifactRevision } from "../artifact-types";
import { compositeId } from "../adapters/core";
import { supportQuestion } from "../__fixtures__/grading";
import { selectArtifactRevision, selectItemQuestion } from "./review-selection";

const earlier: ArtifactRevision = { id: compositeId({ kind: "artifact", runId: "run", unitId: "unit", name: "artifact:earlier" }), status: "draft", created_at: "2026-01-01", body: { summary: "Earlier" }, validation: null };
const latest: ArtifactRevision = { ...earlier, id: compositeId({ kind: "artifact", runId: "run", unitId: "unit", name: "artifact:latest" }), body: { summary: "Latest" } };
const revisions = [earlier, latest];
test("artifact selection defaults to the latest revision object", () => {
  expect(selectArtifactRevision({ revisions, selected_index: null })?.revision).toBe(latest);
});
test.each(["earlier", earlier.id])("a pinned raw or composite revision id preserves the original object: %s", (pinned_revision_id) => {
  expect(selectArtifactRevision({ revisions, selected_index: null, pinned_revision_id })?.revision).toBe(earlier);
});
test("an unavailable artifact pin cannot select a different revision", () => {
  expect(selectArtifactRevision({ revisions, selected_index: null, pinned_revision_id: "missing" })).toBeNull();
});
test("an explicit artifact tab overrides the pin and clamps after history changes", () => {
  expect(selectArtifactRevision({ revisions, selected_index: 9, pinned_revision_id: "earlier" })).toEqual({ index: 1, revision: latest });
});
test("an artifact with no revisions has no selection", () => {
  expect(selectArtifactRevision({ revisions: [], selected_index: null })).toBeNull();
});

const first = supportQuestion();
const second = { ...first, question: { ...first.question, question_version: "2" } };
const questions = [first, second];
test("a question target selects the exact id and version", () => {
  expect(selectItemQuestion({ questions, selected_index: null, target: second.question })).toEqual({ question: second, is_target_missing: false });
});
test("a missing question version stays unavailable instead of selecting the same id's other version", () => {
  expect(selectItemQuestion({ questions, selected_index: null, target: { ...first.question, question_version: "missing" } })).toEqual({ question: null, is_target_missing: true });
});
test("an explicit question tab overrides the recorded target", () => {
  expect(selectItemQuestion({ questions, selected_index: 1, target: first.question })).toEqual({ question: second, is_target_missing: false });
});
test("questions default to the first available question", () => {
  expect(selectItemQuestion({ questions, selected_index: null })).toEqual({ question: first, is_target_missing: false });
});
test("an empty questions page has no selection", () => {
  expect(selectItemQuestion({ questions: [], selected_index: null })).toEqual({ question: null, is_target_missing: false });
});
