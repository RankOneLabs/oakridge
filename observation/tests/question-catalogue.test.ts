import { expect, test } from "bun:test";
import { oakridgeQuestions } from "../src/grading/catalogue/oakridge-questions";
import { pilotExpectations } from "./grading-fixture";
const OAKRIDGE_QUESTIONS = oakridgeQuestions(pilotExpectations);
import { pinnedPilotRecipe, recipeSlots, unsatisfiedSlots } from "../src/grading/evidence-packages/pilot-recipe";
import { contextSchema } from "../src/http/evaluations";
import { registerGradingContext } from "../src/storage/grading-store";
import { withTenant } from "../src/storage/database";
import { tenant, evidence, evaluator, scratchGrading } from "./grading-fixture";

test("each pilot question's pin is readable on its own and its slot counts are enforced", () => {
  for (const entry of Object.values(OAKRIDGE_QUESTIONS)) {
    const recipe = pinnedPilotRecipe(entry.definition);
    expect(recipe).not.toBeNull();
    if (!recipe) continue;
    const slots = recipeSlots(recipe);
    const within = slots.flatMap((slot) => Array.from({ length: Math.max(slot.min_count, 1) },
      (_, index) => ({ ref: `${slot.role}:${index}` })));
    expect(unsatisfiedSlots(recipe, within)).toEqual([]);
    expect(unsatisfiedSlots(recipe, [])).toEqual(slots.filter((slot) => slot.min_count > 0).map((slot) => slot.role));
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

integration("identical catalogue registration is a no-op", () => scratchGrading(async (db) => {
  const { registerQuestion } = await import("../src/storage/grading-store");
  const entry = OAKRIDGE_QUESTIONS["analysis.finding_relevance"].definition;
  expect((await registerQuestion(db, tenant, entry)).ok).toBe(true);
  const rows = () => withTenant(db, tenant, (trx) => trx.selectFrom("observation.question_definition").selectAll().execute());
  const before = await rows();
  expect((await registerQuestion(db, tenant, entry)).ok).toBe(true);
  expect(await rows()).toEqual(before);
}));
integration("changed content under the same version and retargeting across versions are refused explicitly", () => scratchGrading(async (db) => {
  const { registerQuestion } = await import("../src/storage/grading-store");
  const entry = OAKRIDGE_QUESTIONS["analysis.finding_relevance"].definition;
  expect((await registerQuestion(db, tenant, entry)).ok).toBe(true);
  expect(await registerQuestion(db, tenant, { ...entry, question_text: "Changed wording" }))
    .toMatchObject({ ok: false, error: { detail: "question text conflict" } });
  expect(await registerQuestion(db, tenant, { ...entry, unclear_semantics: "Changed semantics" }))
    .toMatchObject({ ok: false, error: { detail: "question definition identity conflict" } });
  expect(await registerQuestion(db, tenant, { ...entry, question_version: "v2", target_item_kinds: ["criterion_wrapper"] }))
    .toMatchObject({ ok: false, error: { detail: expect.stringContaining("subject kind conflict") } });
}));
