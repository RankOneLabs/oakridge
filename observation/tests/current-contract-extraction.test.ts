import { expect, test } from "bun:test";
import { CURRENT_SCHEMA_VERSIONS, definitionsForSchemaVersion, oakridgeCatalogue } from "../src/producers/oakridge/catalogue";
import { logicalIdentityForItem, selectRevision } from "../src/projection/extractor";
import { fixtureBody } from "./grading-fixture";

const current = async (kind: keyof typeof CURRENT_SCHEMA_VERSIONS, fixture = kind as string) =>
  selectRevision(await fixtureBody(`current-${fixture}`), fixture, oakridgeCatalogue(kind, CURRENT_SCHEMA_VERSIONS[kind]));

for (const [kind, legacyIds, currentIds] of [
  ["analysis", ["analysis.findings", "analysis.requirement_statuses", "analysis.proposed_updates", "analysis.risks"], ["analysis.requirement_findings", "analysis.requirements"]],
  ["spec", [], ["spec.requirements"]],
  ["tasks", ["tasks.tasks"], []],
  ["plan", ["plan.decisions", "plan.acceptance_entries", "plan.risks"], ["plan.allocations"]],
  ["brief", ["brief.decisions", "brief.rejected_approaches", "brief.acceptance_entries", "brief.build_items"], ["brief.requirement_build_items", "brief.technical_decisions"]],
  ["assessment", ["assessment.subject_findings", "assessment.findings"], ["assessment.item_assessments", "assessment.additional_findings", "assessment.next_actions"]],
] as const) test(`${kind} dispatch preserves legacy addresses and selects only current extractors`, () => {
  expect(oakridgeCatalogue(kind, "development-v1").map((d) => d.extractor_id)).toEqual([...legacyIds]);
  expect(oakridgeCatalogue(kind, CURRENT_SCHEMA_VERSIONS[kind === "tasks" ? "spec" : kind]).map((d) => d.extractor_id)).toEqual([...currentIds]);
});

test("unknown versions select the unchanged legacy set", () => {
  expect(definitionsForSchemaVersion("unknown").map((d) => d.extractor_id))
    .toEqual(definitionsForSchemaVersion("development-v1").map((d) => d.extractor_id));
});

test("an unrecognized assessment version without findings has no matching items", async () => {
  const definitions = oakridgeCatalogue("assessment", "unknown");
  const pass = selectRevision(await fixtureBody("current-assessment"), "assessment", definitions);
  expect(pass.items).toEqual([]);
  expect(pass.issues.map(({ kind, is_retriable }) => [kind, is_retriable]))
    .toEqual([["no_matching_items", false], ["no_matching_items", false]]);
});

test("analysis links findings only to the enclosing requirement", async () => {
  const pass = await current("analysis");
  expect(pass.issues).toEqual([]);
  expect(pass.items.filter(({ item }) => item.item_kind === "finding").map(({ item }) =>
    [item.producer_local_id, item.links.map((link) => link.target_local_id)]))
    .toEqual([["F1", ["R1"]], ["F2", ["R1"]], ["F3", ["R2"]], ["F4", ["R3"]]]);
});
test("spec requirements share canonical identity and link each named finding", async () => {
  const pass = await current("spec");
  expect(pass.items[0]?.item).toMatchObject({ item_kind: "requirement", item_scope: "task", producer_local_id: "R1", links: [
    { type: "derived_from", target_artifact_kind: "analysis", target_local_id: "F1", recorded_revisions_field: "analysis_revision_ids", evidence_ref: "/requirements/0/analysis_finding_ids/0" },
    { type: "derived_from", target_artifact_kind: "analysis", target_local_id: "F2", recorded_revisions_field: "analysis_revision_ids", evidence_ref: "/requirements/0/analysis_finding_ids/1" },
  ] });
});
test("missing and non-string producer and reference ids fail at the offending path", () => {
  const spec = oakridgeCatalogue("spec", CURRENT_SCHEMA_VERSIONS.spec)[0]!;
  expect(spec.select({ requirements: [{ text: "missing" }] })).toMatchObject({ ok: false, error: { entity_id: "/requirements/0" } });
  expect(spec.select({ requirements: [{ id: "R1", analysis_finding_ids: [3] }] })).toMatchObject({ ok: false, error: { entity_id: "/requirements/0/analysis_finding_ids" } });
  const analysis = oakridgeCatalogue("analysis", CURRENT_SCHEMA_VERSIONS.analysis).find((definition) => definition.extractor_id === "analysis.requirement_findings")!;
  expect(analysis.select({ requirements: [{ id: "R1", findings: [{ id: 2 }] }] })).toMatchObject({ ok: false, error: { entity_id: "/requirements/0/findings/0" } });
});
test("split allocations retain cohort scopes, canonical references and distinct contributions", async () => {
  const pass = await current("plan");
  const shared = pass.items.filter(({ item }) => item.producer_local_id === "R1").map(({ item }) => item);
  expect(shared.map((item) => [item.item_scope, item.selected_value, logicalIdentityForItem(item)])).toEqual([
    ["cohort/C1/allocation", { requirement_id: "R1", contribution: "C1 contribution to R1" }, { scope: "task", producer_local_id: "R1" }],
    ["cohort/C2/allocation", { requirement_id: "R1", contribution: "C2 contribution to R1" }, { scope: "task", producer_local_id: "R1" }],
  ]);
});
test("build items address only requirement_ids and technical decisions address build occurrences", async () => {
  const pass = await current("brief");
  expect(pass.issues).toEqual([]);
  expect(pass.items[0]?.item.links.map((link) => [link.type, link.target_local_id])).toEqual([["addresses", "R1"], ["addresses", "R3"]]);
  expect(pass.items[2]?.item.links).toMatchObject([{ type: "addresses", target: "occurrence", target_scope: "cohort/C1/build_item", target_local_id: "B1" }]);
});
test("cohort assessments resolve brief subjects and preserve unattributed regressions", async () => {
  const pass = await current("assessment");
  expect(pass.issues).toEqual([]);
  expect(pass.items.slice(0, 2).map(({ item }) => item.links)).toMatchObject([
    [{ type: "assesses", target_local_id: "B1", recorded_revisions_field: "brief_revision_ids" }],
    [{ type: "assesses", target_local_id: "B2", recorded_revisions_field: "brief_revision_ids" }],
  ]);
  expect(pass.items.slice(2, 4).map(({ item }) => item.links.map((link) => [link.type, link.target_local_id]))).toEqual([[["addresses", "B1"]], []]);
  expect(pass.items.slice(4).map(({ item }) => item.links)).toMatchObject([
    [{ type: "derived_from", target_item_kind: "additional_finding", target_local_id: "AF1" }],
    [{ type: "derived_from", target_item_kind: "item_assessment", target_local_id: "B1" }],
  ]);
});
test("integration assessments address canonical requirement identity", async () => {
  const pass = await current("assessment", "integration");
  expect(pass.items.at(-1)?.item.links).toEqual([{ target: "logical_item", type: "assesses", target_scope: "task", target_local_id: "R4", evidence_ref: "/item_assessments/3/subject/id" }]);
});
test("a blocker body is one gradeable item with no inferred links", async () => {
  const pass = await current("blocker");
  expect(pass.items.map(({ item }) => [item.item_kind, item.path, item.links])).toEqual([["blocker", "", []]]);
});

test("historical published declaration fingerprints retain legacy extraction", () => {
  const historical = {
    analysis: "4847489074cebfe24f7ecdd9024b351f26ccac021f3f10ce2c788bfa8a5d39e2",
    plan: "66a1e9afac28cdb4b4db8fa8e78c9df02da4ddba1952d189279d22025a4ef79e",
    brief: "c1303586cb5531a0c0aed8a282c0ad68917d94c94834d336705373166479951f",
    assessment: "57f201559fcc23f712187d5d695e6b26d79a583199cc4a394df88e6a36116fc9",
    blocker: "fd7d3d5480c6a7821d205607dc4277d6078ba93c8b3892de4ce4f1877acb96e4",
  };
  for (const [kind, digest] of Object.entries(historical))
    expect(oakridgeCatalogue(kind, `artifact-schema/v1:${digest}`).map((definition) => definition.extractor_id))
      .toEqual(oakridgeCatalogue(kind, "development-v1").map((definition) => definition.extractor_id));
});

test("legacy extractors keep their original logical identity without an explicit override", async () => {
  for (const kind of ["tasks", "plan", "brief", "assessment"]) {
    const pass = selectRevision(await fixtureBody(kind), kind, oakridgeCatalogue(kind, "development-v1"));
    for (const { item } of pass.items) {
      expect(item.logical_item).toBeUndefined();
      expect(logicalIdentityForItem(item)).toEqual(item.item_scope && item.producer_local_id
        ? { scope: item.item_scope, producer_local_id: item.producer_local_id } : null);
    }
  }
});
