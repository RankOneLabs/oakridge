import { expect, test } from "vitest";
import { selectArtifactViewer, VIEWERS } from "../artifactRegistry";
import type { OperatorSchema } from "../operator-contracts/projections/schema-view";

const schemas: OperatorSchema[] = [
  { key: "paid_result", shape: { kind: "record", fields: [{ key: "conclusion", schema: "text" }] } },
  { key: "text", shape: { kind: "string", min_length: 0, max_length: 100 } },
];
const artifact = { view: "assessment", schema: "paid_result", schemas, body: { conclusion: "Replay verified" } };

test("a study artifact with a registered key uses the corresponding viewer", () => {
  expect(selectArtifactViewer(artifact)).toBe(VIEWERS.assessment);
});

test.each([
  { ...artifact, body: { conclusion: false } },
  { ...artifact, view: "unregistered" },
])("an unavailable or incompatible viewer falls back to the contract", (input) => {
  expect(selectArtifactViewer(input)).toBeNull();
});

test("a schema-valid brief with a scalar verification falls back to the contract viewer", () => {
  const brief = { cohort_id: "a", repository_key: "b", depends_on: [], files_in_scope: [],
    build_items: [{ id: "i", instructions: "Fix", requirement_ids: [], verification: "one check" }], technical_decisions: [] };
  const stringList: OperatorSchema = { key: "strings", shape: { kind: "list", max_items: 100, item: "text" } };
  const briefSchemas: OperatorSchema[] = [...schemas, stringList,
    { key: "row", shape: { kind: "record", fields: [{ key: "id", schema: "text" }, { key: "instructions", schema: "text" },
      { key: "requirement_ids", schema: "strings" }, { key: "verification", schema: "text" }] } },
    { key: "rows", shape: { kind: "list", max_items: 100, item: "row" } },
    { key: "brief", shape: { kind: "record", fields: [{ key: "cohort_id", schema: "text" }, { key: "repository_key", schema: "text" },
      { key: "depends_on", schema: "strings" }, { key: "files_in_scope", schema: "strings" },
      { key: "build_items", schema: "rows" }, { key: "technical_decisions", schema: "rows" }] } }];
  expect(selectArtifactViewer({ view: "build_brief", schema: "brief", schemas: briefSchemas, body: brief })).toBeNull();
});
