import { expect, test } from "bun:test";
import { acceptsAnalysisLinkDeclarations } from "../src/domain/analysis-link-declaration";

test("only pinned contracts with a separate tasks schema accept declarations", () => {
  expect([acceptsAnalysisLinkDeclarations(null), acceptsAnalysisLinkDeclarations("legacy-task-schema")]).toEqual([false, true]);
});
