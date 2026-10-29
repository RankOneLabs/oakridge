import { expect, test } from "bun:test";
import { LANGFUSE_PILOT_QUESTIONS } from "../src/grading/catalogue/langfuse-pilot";
import { PILOT_EVIDENCE_RECIPES, projectPilotEvidence, type EvidenceSource } from "../src/langfuse/evidence-recipe";
import { registerGradingContext } from "../src/storage/grading-store";
import { withTenant } from "../src/storage/database";
import { tenant, evidence, evaluator, scratchGrading } from "./grading-fixture";

test("each pilot question projects only its declared digest and deep-link references", () => {
  for (const [id, entry] of Object.entries(LANGFUSE_PILOT_QUESTIONS)) {
    const recipe = PILOT_EVIDENCE_RECIPES[id as keyof typeof PILOT_EVIDENCE_RECIPES];
    const sources: EvidenceSource[] = [...recipe.input, ...recipe.output].map(({ role }) => ({
      role, ref: `revision/${role}`, digest: `canonical-json/v1:${"a".repeat(64)}`,
      deep_link: `https://observation.example/items/${role}`, body: { private: "whole artifact" },
    }));
    const projected = projectPilotEvidence(entry.definition, sources);
    expect(projected.ok).toBe(true);
    if (!projected.ok) continue;
    expect(projected.value.input.map((reference) => reference.role)).toEqual(recipe.input.map((slot) => slot.role));
    expect(projected.value.output.map((reference) => reference.role)).toEqual(recipe.output.map((slot) => slot.role));
    expect([...projected.value.input, ...projected.value.output].every((reference) =>
      Boolean(reference.digest && reference.deep_link) && !("body" in reference))).toBe(true);
  }
});

const integration = process.env.OAKRIDGE_TEST_DATABASE_URL || process.env.CI === "true" ? test : test.skip;
integration("all three pilot definitions satisfy the stored question constraints", async () => scratchGrading(async (db) => {
  for (const entry of Object.values(LANGFUSE_PILOT_QUESTIONS)) {
    const registered = await registerGradingContext(db, tenant, { question: entry.definition, evidence, evaluator: evaluator("human") });
    expect(registered.ok).toBe(true);
  }
  const rows = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.question_definition")
    .select(["question_id", "question_version", "target_item_kinds", "input_recipe", "response_kind", "allowed_values",
      "missing_evidence_policy", "abstain_semantics", "unclear_semantics", "interpretation_caveats"])
    .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
    .where("question_version", "=", "v1").execute());
  expect(rows.map((row) => row.question_id).sort()).toEqual(Object.keys(LANGFUSE_PILOT_QUESTIONS).sort());
  expect(rows.every((row) => Array.isArray(row.target_item_kinds) && row.target_item_kinds.length > 0
    && row.input_recipe !== null && typeof row.input_recipe === "object"
    && ["boolean", "choice", "ordinal", "numeric", "text", "structured"].includes(row.response_kind)
    && ["fail", "abstain"].includes(row.missing_evidence_policy)
    && row.abstain_semantics.length > 0 && row.unclear_semantics.length > 0 && row.interpretation_caveats.length > 0
    && (row.response_kind !== "choice" || (Array.isArray(row.allowed_values) && row.allowed_values.length > 0)))).toBe(true);
}));
