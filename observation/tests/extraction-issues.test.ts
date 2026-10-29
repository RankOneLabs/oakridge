import { expect, test } from "bun:test";
import type { JsonValue } from "../src/domain/primitives";
import { oakridgeDevelopmentCatalogue } from "../src/projection/catalogue/oakridge-development";
import { selectRevision } from "../src/projection/extractor";

test("a malformed selector records a redacted failure while independent selections proceed", () => {
  const body = { findings: [{ id: "finding-a", description: "private secret", severity: "warning" }],
    requirements: "invalid private secret", risks: [], proposed_spec_updates: [] } as unknown as JsonValue;
  const pass = selectRevision(body, "analysis-1", oakridgeDevelopmentCatalogue("analysis", "development-v1"));
  expect(pass.items.some(({ item }) => item.item_kind === "finding")).toBe(true);
  const failure = pass.issues.find((issue) => issue.kind === "extraction_failed");
  expect(failure?.is_retriable).toBe(true);
  expect(failure?.detail.includes("private secret")).toBe(false);
  expect(pass.items.some(({ item }) => item.item_kind === "requirement_status")).toBe(false);
});

test("an empty match is a recorded outcome and never a gradeable item", () => {
  const pass = selectRevision({ findings: [], requirements: [], risks: [], proposed_spec_updates: [] }, "analysis-2",
    oakridgeDevelopmentCatalogue("analysis", "development-v1"));
  expect(pass.items).toEqual([]);
  expect(pass.issues.map((issue) => issue.kind)).toEqual(Array(4).fill("no_matching_items"));
});
