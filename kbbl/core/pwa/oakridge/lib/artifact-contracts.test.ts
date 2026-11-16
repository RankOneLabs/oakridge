import { expect, test } from "vitest";
import fixture from "../__fixtures__/v2-definition-detail.json";
import type { OperatorDefinitionDetail } from "../operator-contracts/projections/definition-view";
import { selectStageInspector } from "./stage-inspector";
import { selectArtifactContracts, selectExpressionIdentifiers } from "./artifact-contracts";
const detail = fixture.definition as unknown as OperatorDefinitionDetail;
test("expression references skip quoted strings and field access", () => {
  expect(selectExpressionIdentifiers("latest(brief).goal + 'brief'")).toEqual(["latest", "brief"]);
});
test("brief contract joins required fields, all producer prompts and review bindings", () => {
  const model = selectStageInspector(detail, {kind: "stage", stage: "brief", tab: null});
  if (!model) throw new Error("brief");
  const contract = selectArtifactContracts(model).find(contract => contract.name === "brief");
  expect(contract).toMatchObject({kind: "document", producers: ["writer"], required_fields: expect.arrayContaining(["acceptance_criteria", "next_action"])});
  expect(contract?.producer_prompts.map(row => row.id)).toEqual(["worker:writer:initial", "worker:writer:revise"]);
  expect(contract?.consumers).toEqual(expect.arrayContaining([{kind: "review_of", review: "brief_review"}, {kind: "review_input", review: "brief_review", input: "brief"}]));
});
test("new record contracts derive fields and prompts without presentation changes", () => {
  const model = selectStageInspector(detail, {kind: "stage", stage: "brief", tab: null});
  if (!model) throw new Error("brief");
  const changed = {...model, stage: {...model.stage, artifacts: {...model.stage.artifacts, release_note: {kind: "record" as const, schema: {kind: "record" as const, fields: {title: {kind: "text" as const}, notes: {kind: "optional" as const, value: {kind: "text" as const}}}}}}}, workers: model.workers.map(entry => ({...entry, worker: {...entry.worker, produces: [...entry.worker.produces, "release_note"]}}))};
  expect(selectArtifactContracts(changed).find(contract => contract.name === "release_note")).toMatchObject({required_fields: ["title"], producers: ["writer"], producer_prompts: expect.arrayContaining([expect.objectContaining({id: "worker:writer:initial"})])});
});
