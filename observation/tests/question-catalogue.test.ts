import { expect, test } from "bun:test";
import { oakridgeQuestions } from "../src/grading/catalogue/oakridge-questions";
import { pilotExpectations } from "./grading-fixture";
const OAKRIDGE_QUESTIONS = oakridgeQuestions(pilotExpectations);
import { PILOT_EVIDENCE_RECIPES, projectPilotEvidence, type EvidenceSource } from "../src/grading/evidence-packages/pilot-recipe";
import { contextSchema } from "../src/http/evaluations";
import { registerGradingContext } from "../src/storage/grading-store";
import { withTenant } from "../src/storage/database";
import { tenant, evidence, evaluator, scratchGrading } from "./grading-fixture";

test("each pilot question projects only its declared digest and deep-link references", () => {
  for (const [id, entry] of Object.entries(OAKRIDGE_QUESTIONS)) {
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
integration("all four pilot definitions satisfy the stored question constraints", async () => scratchGrading(async (db) => {
  for (const entry of Object.values(OAKRIDGE_QUESTIONS)) {
    const registered = await registerGradingContext(db, tenant, { question: entry.definition, evidence, evaluator: evaluator("human") });
    expect(registered.ok).toBe(true);
  }
  const rows = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.question_definition")
    .select(["question_id", "question_version", "target_item_kinds", "input_recipe", "response_kind", "allowed_values",
      "missing_evidence_policy", "abstain_semantics", "unclear_semantics", "interpretation_caveats"])
    .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
    .where("question_version", "=", "v1").execute());
  expect(rows.map((row) => row.question_id).sort()).toEqual(Object.keys(OAKRIDGE_QUESTIONS).sort());
  expect(rows.every((row) => Array.isArray(row.target_item_kinds) && row.target_item_kinds.length > 0
    && row.input_recipe !== null && typeof row.input_recipe === "object"
    && ["boolean", "choice", "ordinal", "numeric", "text", "structured"].includes(row.response_kind)
    && ["fail", "abstain"].includes(row.missing_evidence_policy)
    && row.abstain_semantics.length > 0 && row.unclear_semantics.length > 0 && row.interpretation_caveats.length > 0
    && (row.response_kind !== "choice" || (Array.isArray(row.allowed_values) && row.allowed_values.length > 0)))).toBe(true);
}));

test("four pilot questions retain their caller-supplied definition and target schema pins", () => {
  const expectations = {
    ...pilotExpectations,
    "analysis.finding_relevance": { definition_id: "release-analysis", artifact_schema_version: "analysis-schema" },
    "plan.criterion_traceability": { definition_id: "release-plan", artifact_schema_version: "plan-schema" },
    "brief.source_fidelity": { definition_id: "release-brief", artifact_schema_version: "brief-schema" },
    "assessment.coverage": { definition_id: "release-brief", artifact_schema_version: "brief-schema" },
  };
  const catalogue = oakridgeQuestions(expectations);
  expect(Object.values(catalogue).map(({ definition }) => ({ question_id: String(definition.question_id),
    version: definition.question_version, kinds: definition.target_item_kinds, pin: definition.pinned_expectation })))
    .toEqual(Object.entries(expectations).map(([question_id, pin]) => ({ question_id, version: "v1",
      kinds: [question_id === "analysis.finding_relevance" ? "finding" : "criterion"], pin })));
});

integration("a question without a pinned expectation is a contract error with no registration", async () => scratchGrading(async (db) => {
  const { pinned_expectation: _, ...unpinned } = OAKRIDGE_QUESTIONS["plan.criterion_traceability"].definition;
  // @ts-expect-error A question without an expectation cannot satisfy the registration contract.
  const result = await registerGradingContext(db, tenant, { question: unpinned, evidence, evaluator: evaluator("code") });
  expect(result).toMatchObject({ ok: false, error: { detail: "question requires pinned expectation" } });
  expect(await withTenant(db, tenant, (trx) => trx.selectFrom("observation.question_definition").selectAll().execute())).toEqual([]);
}));

test("the HTTP question contract requires its expectation", () => {
  const { pinned_expectation: _, ...unpinned } = OAKRIDGE_QUESTIONS["plan.criterion_traceability"].definition;
  expect(contextSchema.safeParse({ question: unpinned, evidence, evaluator: evaluator("code") }).success).toBe(false);
});
