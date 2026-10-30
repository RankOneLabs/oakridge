import { err, ok, type Result } from "../../domain/primitives";
import { canonicalJson } from "../../canonical/canonical-json";
import type { QuestionDefinition } from "../question";

export type PilotQuestionId = "analysis.finding_relevance" | "plan.criterion_traceability" | "brief.source_fidelity"
  | "assessment.coverage";
export const EVIDENCE_ROLES = ["requested_change", "relevant_excerpt", "analysis_finding", "plan_task", "plan_decision",
  "plan_criterion", "brief_criterion", "assessment_finding"] as const;
export type EvidenceRole = typeof EVIDENCE_ROLES[number];
export interface EvidenceSlot { readonly role: EvidenceRole; readonly min_count: number; readonly max_count: number }
export interface PilotEvidenceRecipe {
  readonly recipe_id: PilotQuestionId;
  readonly recipe_version: "v1";
  readonly input: readonly EvidenceSlot[];
  readonly output: readonly EvidenceSlot[];
  readonly projected_fields: readonly ["ref", "digest", "deep_link"];
}
export interface EvidenceSource {
  readonly role: EvidenceRole;
  readonly ref: string;
  readonly digest: string;
  readonly deep_link: string;
}
export interface ProjectedEvidence {
  readonly role: EvidenceRole;
  readonly ref: string;
  readonly digest: string;
  readonly deep_link: string;
}
export interface ProjectedQuestionEvidence {
  readonly recipe_id: PilotQuestionId;
  readonly recipe_version: "v1";
  readonly input: readonly ProjectedEvidence[];
  readonly output: readonly ProjectedEvidence[];
}
export interface EvidenceRecipeError { readonly operation: "project_pilot_evidence"; readonly entity_id: string; readonly detail: string }

/** A bounded package of source addresses; full code, spec, and JSON stay in the observation store.
 * Every package carries at least one input reference, whatever its slots' minimums. */
export const PILOT_EVIDENCE_RECIPES: Readonly<Record<PilotQuestionId, PilotEvidenceRecipe>> = {
  "analysis.finding_relevance": { recipe_id: "analysis.finding_relevance", recipe_version: "v1",
    input: [{ role: "requested_change", min_count: 1, max_count: 1 }, { role: "relevant_excerpt", min_count: 1, max_count: 1 }],
    output: [{ role: "analysis_finding", min_count: 1, max_count: 1 }], projected_fields: ["ref", "digest", "deep_link"] },
  "plan.criterion_traceability": { recipe_id: "plan.criterion_traceability", recipe_version: "v1",
    input: [{ role: "plan_task", min_count: 0, max_count: 20 }, { role: "plan_decision", min_count: 0, max_count: 20 }],
    output: [{ role: "plan_criterion", min_count: 1, max_count: 1 }], projected_fields: ["ref", "digest", "deep_link"] },
  "brief.source_fidelity": { recipe_id: "brief.source_fidelity", recipe_version: "v1",
    input: [{ role: "plan_criterion", min_count: 1, max_count: 1 }],
    output: [{ role: "brief_criterion", min_count: 1, max_count: 1 }], projected_fields: ["ref", "digest", "deep_link"] },
  "assessment.coverage": { recipe_id: "assessment.coverage", recipe_version: "v1",
    input: [{ role: "brief_criterion", min_count: 1, max_count: 1 }],
    output: [{ role: "assessment_finding", min_count: 0, max_count: 100 }], projected_fields: ["ref", "digest", "deep_link"] },
};

export function pinnedInputRecipe(recipe: PilotEvidenceRecipe): QuestionDefinition["input_recipe"] {
  return { recipe_id: recipe.recipe_id, recipe_version: recipe.recipe_version,
    input_roles: recipe.input.map((slot) => slot.role), output_roles: recipe.output.map((slot) => slot.role),
    projected_fields: [...recipe.projected_fields] };
}

export function projectPilotEvidence(question: QuestionDefinition, sources: readonly EvidenceSource[])
  : Result<ProjectedQuestionEvidence, EvidenceRecipeError> {
  const recipe = PILOT_EVIDENCE_RECIPES[question.question_id as PilotQuestionId];
  const expected = recipe ? canonicalJson(pinnedInputRecipe(recipe)) : null;
  const actual = canonicalJson(question.input_recipe);
  if (!recipe || question.question_version !== recipe.recipe_version || !expected?.ok || !actual.ok
    || expected.value !== actual.value)
    return err({ operation: "project_pilot_evidence", entity_id: question.question_id, detail: "question has no pinned pilot evidence recipe" });
  const slots = [...recipe.input, ...recipe.output];
  const allowed = new Set<EvidenceRole>(slots.map((slot) => slot.role));
  if (sources.some((source) => !allowed.has(source.role)))
    return err({ operation: "project_pilot_evidence", entity_id: question.question_id, detail: "undeclared evidence role" });
  const selected = (slot: EvidenceSlot): Result<readonly ProjectedEvidence[], EvidenceRecipeError> => {
    const matches = sources.filter((source) => source.role === slot.role);
    if (matches.length < slot.min_count || matches.length > slot.max_count)
      return err({ operation: "project_pilot_evidence", entity_id: slot.role, detail: "evidence count differs from pinned recipe" });
    if (matches.some((source) => !source.ref || source.ref.length > 512 || !source.digest || source.digest.length > 128
      || !source.deep_link || source.deep_link.length > 2048))
      return err({ operation: "project_pilot_evidence", entity_id: slot.role, detail: "evidence requires a ref, digest and deep link" });
    return ok(matches.map(({ role, ref, digest, deep_link }) => ({ role, ref, digest, deep_link })));
  };
  const input: ProjectedEvidence[] = [];
  const output: ProjectedEvidence[] = [];
  for (const slot of recipe.input) {
    const result = selected(slot);
    if (!result.ok) return result;
    input.push(...result.value);
  }
  if (input.length === 0)
    return err({ operation: "project_pilot_evidence", entity_id: question.question_id, detail: "evidence requires at least one input reference" });
  for (const slot of recipe.output) {
    const result = selected(slot);
    if (!result.ok) return result;
    output.push(...result.value);
  }
  return ok({ recipe_id: recipe.recipe_id, recipe_version: recipe.recipe_version, input, output });
}
