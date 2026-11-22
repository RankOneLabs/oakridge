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
