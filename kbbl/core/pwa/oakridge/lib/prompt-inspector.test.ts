import { expect, test } from "vitest";
import fixture from "../__fixtures__/v2-definition-detail.json";
import type { OperatorDefinitionDetail } from "../operator-contracts/projections/definition-view";
import { selectStageInspector } from "./stage-inspector";
import { selectPromptRows } from "./prompt-inspector";
const detail = fixture.definition as unknown as OperatorDefinitionDetail;
function stage(name: string) {
  const model = selectStageInspector(detail, {kind: "stage", stage: name, tab: null});
  if (!model) throw new Error(name);
  return model;
}
test("each worker prompt role preserves produced artifacts and stored bytes", () => {
  const rows = selectPromptRows(stage("cohort"));
  for (const mode of ["initial", "revise"]) expect(rows.find(row => row.id === "worker:builder:" + mode)).toMatchObject({produces: ["build_result", "pr"]});
  expect(rows.filter(row => row.owner.key === "assessor").map(row => row.id).sort()).toEqual(["worker:assessor:review", "worker:assessor:revise"]);
  for (const row of rows) expect({body: row.body, digest: row.digest}).toEqual(detail.prompts[row.path]);
});
test("shared review prompt keeps distinct owners and reviewed artifacts", () => {
  const rows = ["cohort", "integration"].map(name => selectPromptRows(stage(name)).find(row => row.id === "review:merge_confirmation:review"));
  expect(rows.map(row => row?.path)).toEqual(["development/merge-confirmation.md", "development/merge-confirmation.md"]);
  expect(rows[0]?.digest).toBe(rows[1]?.digest);
  expect(rows.map(row => row?.owner)).toMatchObject([{of: "pr"}, {of: "manual_merge_target"}]);
});
test("missing stored prompt retains the path with null content", () => {
  const model = stage("brief");
  const row = selectPromptRows(model)[0];
  const prompts = {...detail.prompts}; delete prompts[row.path];
  expect(selectPromptRows({...model, definition: {...detail, prompts}})[0]).toMatchObject({path: row.path, body: null, digest: null});
});
test("worker declarations add and remove all their prompt relationships", () => {
  const model = stage("cohort");
  const worker = {stage: model.name, key: "extra_writer", source: null, worker: {kind: "agent" as const, inputs: {}, produces: ["one", "two"], prompts: {initial: "x/a.md"}}};
  expect(selectPromptRows({...model, workers: [...model.workers, worker]}).find(row => row.owner.key === "extra_writer")).toMatchObject({id: "worker:extra_writer:initial", path: "x/a.md", produces: ["one", "two"], body: null, digest: null});
  expect(selectPromptRows({...model, workers: model.workers.filter(entry => entry.key !== "builder")}).some(row => row.owner.key === "builder")).toBe(false);
});
