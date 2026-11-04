import { z } from "zod";
import { err, ok, type Result } from "../../domain/primitives";
import { gradingSubjectRefusal, type QuestionDefinition } from "../question";
import type { EvidencePackageError } from "./references";
import { judgeNeedsRepository, judgeRecipeSchema, type JudgeRecipe } from "./judge-recipe";
import { schemaProvenanceEligibility, type SchemaSupport, type SupportSubject } from "../eligibility";
import { pinnedPilotRecipe, type PilotEvidenceRecipe } from "./pilot-recipe";

export type RecipeError = EvidencePackageError;

/** The recipe variants that can build evidence from production capture. A question declares
 * which one applies by what it pins, so this is read from `input_recipe` and never from a
 * table of question ids. */
export type PinnedRecipe =
  | { readonly kind: "slots"; readonly slots: PilotEvidenceRecipe }
  | { readonly kind: "judge"; readonly judge: JudgeRecipe };

/** The single derivation of "which recipe does this question pin". Consumers read this
 * instead of asking each recipe module in turn. */
export function pinnedRecipe(question: QuestionDefinition): PinnedRecipe | null {
  const slots = pinnedPilotRecipe(question);
  if (slots) return { kind: "slots", slots };
  const judge = judgeRecipeSchema.safeParse(question.input_recipe);
  return judge.success ? { kind: "judge", judge: judge.data } : null;
}

/** Whether captured evidence can be built for this question at all. */
export function hasCapturedEvidenceRecipe(question: QuestionDefinition): boolean {
  return pinnedRecipe(question) !== null;
}

/** Code judges require a matching repository snapshot even without the explicit flag. */
export function requiresRepositorySnapshot(question: QuestionDefinition): boolean {
  return question.requires_repository_snapshot || judgeNeedsRepository(question);
}

const repositoryMinimumSchema = z.object({ minimum_repository_content: z.number().int().min(1) });

/** How many repository references the pin requires before a snapshot question is eligible.
 * Absent means one. A present but invalid value is a pin error, not a silent fall back to one —
 * three call sites previously read it off the raw pin with `Number(... ?? 1)`, so a typo or a
 * string became "one reference is enough". */
export function pinnedRepositoryMinimum(question: QuestionDefinition): Result<number, RecipeError> {
  if (!("minimum_repository_content" in question.input_recipe)) return ok(1);
  const parsed = repositoryMinimumSchema.safeParse(question.input_recipe);
  return parsed.success ? ok(parsed.data.minimum_repository_content)
    : err({ operation: "evidence_packages", entity_id: String(question.question_id),
      detail: "minimum_repository_content must be a positive integer" });
}

export function schemaSupport(question: QuestionDefinition, subject: SupportSubject): SchemaSupport {
  const refusal = gradingSubjectRefusal(subject.item_kind, question.question_id, question.question_version);
  if (refusal) return { state: "unsupported", reason: refusal };
  const provenance = schemaProvenanceEligibility(question.pinned_expectation, subject);
  if (provenance.tag !== "eligible") return { state: "unsupported", reason: provenance.payload.reason };
  if (!question.target_item_kinds.includes(subject.item_kind))
    return { state: "unsupported", reason: "question does not target extractor-selected item kind" };
  const recipe = pinnedRecipe(question);
  if (!recipe || (recipe.kind === "slots" && (recipe.slots.subject.item_kind !== subject.item_kind
    || recipe.slots.subject.artifact_kind !== subject.artifact_kind)))
    return { state: "unsupported", reason: "pinned recipe is not implemented for subject" };
  return { state: "supported" };
}
