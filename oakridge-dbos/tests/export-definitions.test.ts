import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { canonicalJson } from "canonical-json";
import { planDefinitionExport, writeDefinitionExport, type ConversionReview, type LegacyDefinitionRow } from "../scripts/export-definitions";
import { resolveHistoricalDefinition } from "../src/definitions/store";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
function json(value: unknown): string {
  const result = canonicalJson(value);
  if (!result.ok) throw new Error(result.error.detail);
  return result.value;
}
function fixture() {
  const prompt = "recorded prompt\n";
  const promptId = sha(prompt);
  const row: LegacyDefinitionRow = { id: "legacy-unlaunchable", digest: "legacy-digest",
    source_text: json({ workflow: "old", input: {}, run: { units: {}, outcome: {} }, stages: {} }),
    program_text: json({ digest: "recorded-core-digest", workflow: { workflow: "old" }, stages: [], operations: [] }),
    prompts_text: json({ "old.md": promptId }) };
  return { row, prompt: { content_digest: promptId, content: prompt } };
}

test("exports an unlaunchable historical program, prompts and old-ID mapping", () => {
  const { row, prompt } = fixture();
  const root = mkdtempSync(resolve(tmpdir(), "oakridge-export-"));
  try {
    const plan = planDefinitionExport({ definitions: [row], prompts: [prompt], conversion_reviews: [] });
    writeDefinitionExport(root, plan);
    const mapped = plan.manifest.definitions[row.id]!;
    expect(resolveHistoricalDefinition(mapped.definition_id, root).program.digest).toBe("recorded-core-digest");
    expect(readFileSync(resolve(root, "legacy-definition-map.json"), "utf8")).toContain(row.id);
    writeDefinitionExport(root, plan);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("missing recorded dependencies name affected legacy IDs before export writes", () => {
  const { row } = fixture();
  expect(() => planDefinitionExport({ definitions: [row], prompts: [], conversion_reviews: [] }))
    .toThrow("legacy-unlaunchable: old.md");
  const missingOperations = { ...row, program_text: json({ digest: "old", workflow: {}, stages: [] }) };
  expect(() => planDefinitionExport({ definitions: [missingOperations], prompts: [], conversion_reviews: [] }))
    .toThrow("legacy-unlaunchable: recorded operations");
});

test("noncanonical jsonb rendering needs a matching independent conversion review", () => {
  const { row, prompt } = fixture();
  const changed = { ...row, source_text: '{"workflow": "old", "input": {}, "run": {"units": {}, "outcome": {}}, "stages": {}}' };
  expect(() => planDefinitionExport({ definitions: [changed], prompts: [prompt], conversion_reviews: [] }))
    .toThrow("NoncanonicalHistoricalBytes");
  const review: ConversionReview = { legacy_id: changed.id, source_sha256: sha(changed.source_text),
    program_sha256: sha(changed.program_text), prompts_sha256: sha(changed.prompts_text) };
  const plan = planDefinitionExport({ definitions: [changed], prompts: [prompt], conversion_reviews: [review] });
  expect(plan.manifest.definitions[changed.id]?.source_jsonb_text).toBe(changed.source_text);
  expect(() => planDefinitionExport({ definitions: [changed], prompts: [prompt],
    conversion_reviews: [{ ...review, source_sha256: "0".repeat(64) }] })).toThrow("NoncanonicalHistoricalBytes");
});
