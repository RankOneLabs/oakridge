import { expect, test } from "vitest";
import fixture from "../__fixtures__/v2-definition-detail.json";
import type { OperatorDefinitionDetail } from "../operator-contracts/projections/definition-view";
import { selectStageInspector } from "./stage-inspector";
import { selectArtifactContracts, selectExpressionIdentifiers, selectResolvedContractType } from "./artifact-contracts";
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

test("cohort contracts join all builder prompts and build-result consumers", () => {
  const model = selectStageInspector(detail, {kind: "stage", stage: "cohort", tab: null});
  if (!model) throw new Error("cohort");
  const contracts = selectArtifactContracts(model);
  expect(contracts.find(contract => contract.name === "pr")?.producer_prompts.map(row => row.id)).toEqual([
    "worker:builder:initial", "worker:builder:revise",
  ]);
  const build_result = contracts.find(contract => contract.name === "build_result");
  expect(build_result?.producers).toEqual(["builder"]);
  expect(build_result?.consumers).toEqual(expect.arrayContaining([
    {kind: "review_of", review: "pr_closed"},
    {kind: "evaluates", worker: "assessor"},
  ]));
});

test("tokenization preserves quoted words and repeated field references", () => {
  expect(selectExpressionIdentifiers('brief + value.brief + "brief" + value.goal + brief')).toEqual(["brief", "value"]);
});

test("integration pr consumers include outcomes reached through stage aliases", () => {
  const model = selectStageInspector(detail, {kind: "stage", stage: "integration", tab: null});
  if (!model) throw new Error("integration");
  expect(model.sections.artifacts.find(contract => contract.name === "pr")?.consumers).toContainEqual({kind: "outcome", name: "is_merged"});
});

test("consumer aliases traverse bindings and terminate cycles without linking quoted or field names", () => {
  const model = selectStageInspector(detail, {kind: "stage", stage: "brief", tab: null});
  if (!model) throw new Error("brief");
  const stage = {...model.stage, let: {first: "latest(brief)", second: "first", cycle_a: "cycle_b", cycle_b: "cycle_a"}, outcome: {via_alias: "second.goal", cycle: "cycle_a", quoted: "'brief'", field: "input.brief"}};
  const contract = selectArtifactContracts({...model, stage}).find(contract => contract.name === "brief");
  expect(contract?.consumers.filter(consumer => consumer.kind === "outcome")).toEqual([{kind: "outcome", name: "via_alias"}]);
});

test("required fields follow named optional aliases and preserve required named fields", () => {
  const model = selectStageInspector(detail, {kind: "stage", stage: "brief", tab: null});
  if (!model) throw new Error("brief");
  const schemas = {...detail.effective_workflow.schemas, maybe_text: {kind: "optional" as const, value: {kind: "text" as const}}, alias: {kind: "named" as const, schema: "maybe_text"}, title_text: {kind: "text" as const}};
  const contract = {kind: "record" as const, schema: {kind: "record" as const, fields: {title: {kind: "named" as const, schema: "title_text"}, notes: {kind: "named" as const, schema: "alias"}}}};
  const changed = {...model, definition: {...detail, effective_workflow: {...detail.effective_workflow, schemas}}, stage: {...model.stage, artifacts: {release_note: contract}}};
  expect(selectArtifactContracts(changed)[0]?.required_fields).toEqual(["title"]);
});

test("schema resolution preserves missing names and terminates alias cycles", () => {
  expect(selectResolvedContractType({kind: "named", schema: "missing"}, {})).toEqual({kind: "named", schema: "missing"});
  expect(selectResolvedContractType({kind: "named", schema: "a"}, {a: {kind: "named", schema: "b"}, b: {kind: "named", schema: "a"}})).toEqual({kind: "named", schema: "a"});
});
