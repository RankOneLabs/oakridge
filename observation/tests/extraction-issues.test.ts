import { expect, test } from "bun:test";
import { selectRegistration } from "../src/producers/oakridge/catalogue";
import { selectRevision } from "../src/projection/extractor";
import { developmentKeys } from "./grading-fixture";

const key = developmentKeys.analysis;
const extractors = selectRegistration({ definition_id: key.definition_id, stage: key.stage, artifact_kind: key.artifact,
  artifact_schema_version: key.schema_version })!.extractors;

test("a malformed selector records a redacted failure while independent selections proceed", () => {
  const pass = selectRevision({ requirements: [{ id: "R1", findings: "invalid private secret" }] }, "analysis-1", extractors);
  expect(pass.items.map(({ item }) => item.item_kind)).toEqual(["requirement"]);
  expect(pass.issues).toHaveLength(1);
  expect(pass.issues[0]).toMatchObject({ kind: "extraction_failed", is_retriable: true });
  expect(pass.issues[0]?.detail).not.toContain("private secret");
});

test("an authored empty list produces no gradeable item or extraction issue", () => {
  expect(selectRevision({ requirements: [] }, "analysis-2", extractors)).toEqual({ items: [], issues: [] });
});
