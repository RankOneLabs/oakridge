import { expect, test } from "bun:test";
import type { ArtifactRevisionId, ItemOccurrenceId, LogicalItemId, QuestionId, RunId } from "../src/domain/identity";
import type { CapturedRevision, CapturedSources, SourceArtifact } from "../src/ports/artifact-source";
import type { JsonValue } from "../src/domain/primitives";
import { oakridgeCapabilities } from "../src/producers/oakridge/evidence";
import { fixtureBody } from "./grading-fixture";

const revision = (kind: string, body: JsonValue): CapturedRevision => ({ revision_id: kind as ArtifactRevisionId,
  artifact_kind: kind, stage: kind, subject_id: null, body });
async function context() {
  const revisions = new Map<string, CapturedRevision>();
  for (const kind of ["analysis", "spec", "plan", "brief", "assessment"]) revisions.set(kind, revision(kind, await fixtureBody(`current-${kind}`)));
  const source: CapturedSources = {
    readRevision: async (id) => revisions.get(id) ?? null,
    readRevisionAt: async (kind) => revisions.get(kind) ?? null,
    readRunInput: async () => null,
    readLinkedItems: async () => [{ revision_id: "brief" as ArtifactRevisionId, item_kind: "build_item", item_path: "/build_items/0", selected_value: { id: "B1", requirement_ids: ["R1", "R3"] } }],
    readLogicalItemAt: async () => ({ revision_id: "spec" as ArtifactRevisionId, item_kind: "requirement", item_path: "/requirements/0", selected_value: { id: "R1", text: "Requirement R1", acceptance_conditions: ["Accept R1"] } }),
    repository: { hasCommit: async () => false, readFile: async () => ({ state: "absent" }) },
  };
  const artifact: SourceArtifact = { occurrence_id: "B1" as ItemOccurrenceId, revision_id: "brief" as ArtifactRevisionId,
    run_id: "run" as RunId, item_path: "/build_items/0", item_kind: "build_item", selected_value: { id: "B1", requirement_ids: ["R1", "R3"] } };
  return { revisions, source, artifact, question: { question_id: "test" as QuestionId, question_version: "1", task_id: "R1" as LogicalItemId } };
}
test("current build-item evidence includes every canonical requirement's text and acceptance conditions", async () => {
  const { source: sources, artifact, question } = await context();
  const result = await oakridgeCapabilities.build_item_context!.resolve({ artifact, question, sources }, {});
  expect(result).toMatchObject({ state: "ready", references: [
    { ref: "subject" }, { ref: "task_context:0" }, { ref: "brief" }, { ref: "cohort" },
    { ref: "requirement:0", revision_id: "spec", content: { id: "R1", text: "Requirement R1", acceptance_conditions: ["Accept R1"] } },
    { ref: "requirement:1", revision_id: "spec", content: { id: "R3", text: "Requirement R3", acceptance_conditions: ["Accept R3"] } },
  ] });
});
test("current findings resolve the enclosing analysis requirement before any spec exists", async () => {
  const { source: sources, revisions, artifact, question } = await context();
  revisions.delete("spec");
  const result = await oakridgeCapabilities.requirement!.resolve({ sources, question,
    artifact: { ...artifact, revision_id: "analysis" as ArtifactRevisionId, item_kind: "finding", item_path: "/requirements/1/findings/0", selected_value: { id: "F3" } } },
    { artifact: "spec", list: "/requirements", task_source: { artifact: "spec", list: "/requirements" } });
  expect(result).toMatchObject({ state: "ready", references: [{ ref: "requirement:0", revision_id: "analysis", item_path: "/requirements/1", content: { id: "R2", text: "Requirement R2" } }] });
});
test("allocations resolve requirement_id in the spec", async () => {
  const { source: sources, artifact, question } = await context();
  expect(await oakridgeCapabilities.requirement_context!.resolve({ sources, question,
    artifact: { ...artifact, item_kind: "allocation", selected_value: { requirement_id: "R3", contribution: "work" } } }, {}))
    .toMatchObject({ state: "ready", references: [{ ref: "requirement:0", content: { id: "R3", text: "Requirement R3" } },
      { ref: "spec_task", content: { id: "R3", text: "Requirement R3" } }] });
});
test("item assessments collect the brief build item from recorded provenance", async () => {
  const { source: sources, revisions, artifact, question } = await context();
  revisions.set("assessment", { ...revisions.get("assessment")!, brief_revision_ids: ["brief"] });
  expect(await oakridgeCapabilities.assessed_build_items!.resolve({ sources, question,
    artifact: { ...artifact, revision_id: "assessment" as ArtifactRevisionId, item_kind: "item_assessment", selected_value: { subject: { kind: "build_item", id: "B1" } } } }, {}))
    .toMatchObject({ state: "ready", references: [{ ref: "assessed_build_item:0", revision_id: "brief", content: { id: "B1" } }] });
});

test("canonical spec evidence retains the spec_task name used by existing evaluators", async () => {
  const { source: sources, artifact, question } = await context();
  expect(await oakridgeCapabilities.spec_task!.resolve({ sources, question,
    artifact: { ...artifact, item_kind: "requirement", selected_value: { id: "R1" } } }, { artifact: "spec", list: "/requirements" }))
    .toMatchObject({ state: "ready", references: [{ ref: "spec_task", content: { id: "R1", text: "Requirement R1" } }] });
});
