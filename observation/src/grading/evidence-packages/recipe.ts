import type { QuestionDefinition } from "../question";
import { judgeRecipeSchema, type JudgeRecipe } from "./judge-recipe";
import { pinnedPilotRecipe, type PilotEvidenceRecipe } from "./pilot-recipe";

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
