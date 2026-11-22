import { expect, test } from "bun:test";
import { selectRegistration } from "../src/producers/oakridge/catalogue";
import { logicalIdentityForItem, selectRevision } from "../src/projection/extractor";
import { developmentKeys, fixtureBody } from "./grading-fixture";
import { ARTIFACT_KEYS, type ArtifactKey } from "../src/producers/oakridge/artifact-versions";

const catalogue = (key: ArtifactKey) => selectRegistration({ definition_id: key.definition_id ?? "", stage: key.stage,
  artifact_kind: key.artifact, artifact_schema_version: key.schema_version })?.extractors ?? [];
const current = async (kind: keyof typeof developmentKeys, fixture = kind as string) =>
  selectRevision(await fixtureBody(`current-${fixture}`), fixture,
    catalogue(fixture === "integration" ? ARTIFACT_KEYS.development.integration.assessment : developmentKeys[kind]));

test("analysis links findings only to the enclosing requirement", async () => {
  const pass = await current("analysis");
  expect(pass.issues).toEqual([]);
  expect(pass.items.filter(({ item }) => item.item_kind === "finding").map(({ item }) =>
    [item.producer_local_id, item.links.map((link) => link.target === "address" ? link.revision_id : link.target_local_id)]))
    .toEqual([["F1", ["R1"]], ["F2", ["R1"]], ["F3", ["R2"]], ["F4", ["R3"]]]);
});
test("spec requirements share canonical identity and link each named finding", async () => {
  const pass = await current("spec");
  expect(pass.items[0]?.item).toMatchObject({ item_kind: "requirement", item_scope: "task", logical_item: { task_kind: "requirement" }, producer_local_id: "R1", links: [
    { type: "derived_from", target_artifact_kind: "analysis", target_local_id: "F1", target_bound: true, evidence_ref: "/requirements/0/analysis_finding_ids/0" },
    { type: "derived_from", target_artifact_kind: "analysis", target_local_id: "F2", target_bound: true, evidence_ref: "/requirements/0/analysis_finding_ids/1" },
  ] });
});
test("missing and non-string producer and reference ids fail at the offending path", () => {
  const spec = catalogue(developmentKeys.spec)[0]!;
  expect(spec.select({ requirements: [{ text: "missing" }] })).toMatchObject({ ok: false, error: { entity_id: "/requirements/0" } });
  expect(spec.select({ requirements: [{ id: "R1", analysis_finding_ids: [3] }] })).toMatchObject({ ok: false, error: { entity_id: "/requirements/0/analysis_finding_ids" } });
  const analysis = catalogue(developmentKeys.analysis).find((definition) => definition.extractor_id === "analysis.requirement_findings")!;
  expect(analysis.select({ requirements: [{ id: "R1", findings: [{ id: 2 }] }] })).toMatchObject({ ok: false, error: { entity_id: "/requirements/0/findings/0" } });
});
test("split allocations retain cohort scopes, canonical references and distinct contributions", async () => {
  const pass = await current("plan");
  const shared = pass.items.filter(({ item }) => item.producer_local_id === "R1").map(({ item }) => item);
  expect(shared.map((item) => [item.item_scope, item.selected_value, logicalIdentityForItem(item)])).toEqual([
    ["cohort/C1/allocation", { requirement_id: "R1", contribution: "C1 contribution to R1" }, { scope: "task", task_kind: "requirement", producer_local_id: "R1" }],
    ["cohort/C2/allocation", { requirement_id: "R1", contribution: "C2 contribution to R1" }, { scope: "task", task_kind: "requirement", producer_local_id: "R1" }],
  ]);
});
test("build items address only requirement_ids and technical decisions address build occurrences", async () => {
  const pass = await current("brief");
  expect(pass.issues).toEqual([]);
  expect(pass.items[0]?.item.links.map((link) => [link.type, link.target === "address" ? link.revision_id : link.target_local_id])).toEqual([["addresses", "R1"], ["addresses", "R3"]]);
  expect(pass.items[2]?.item.links).toMatchObject([{ type: "addresses", target: "occurrence", target_scope: "cohort/C1/build_item", target_local_id: "B1" }]);
});
test("cohort assessments resolve brief subjects and preserve unattributed regressions", async () => {
  const pass = await current("assessment");
  expect(pass.issues).toEqual([]);
  expect(pass.items.slice(0, 2).map(({ item }) => item.links)).toMatchObject([
    [{ type: "assesses", target_local_id: "B1", target_bound: true }],
    [{ type: "assesses", target_local_id: "B2", target_bound: true }],
  ]);
  expect(pass.items.slice(2, 4).map(({ item }) => item.links.map((link) => [link.type, link.target === "address" ? link.revision_id : link.target_local_id]))).toEqual([[["addresses", "B1"]], []]);
  expect(pass.items.slice(4).map(({ item }) => item.links)).toMatchObject([
    [{ type: "derived_from", target: "address", pointer: "/additional_findings/0" }],
    [{ type: "derived_from", target: "address", pointer: "/item_assessments/0" }],
  ]);
});
test("integration assessments address canonical requirement identity", async () => {
  const pass = await current("assessment", "integration");
  expect(pass.items.filter(({ item }) => item.item_kind === "item_assessment").at(-1)?.item.links).toEqual([{ target: "logical_item", type: "assesses", target_scope: "task", target_task_kind: "requirement", target_local_id: "R4", evidence_ref: "/item_assessments/3/subject/id" }]);
});
test("a blocker body is one gradeable item with no inferred links", async () => {
  const pass = await current("blocker");
  expect(pass.items.map(({ item }) => [item.item_kind, item.path, item.links])).toEqual([["blocker", "", []]]);
});
