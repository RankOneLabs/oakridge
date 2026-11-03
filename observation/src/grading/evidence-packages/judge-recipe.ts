import { z } from "zod";
import type { QuestionDefinition } from "../question";

/** The same pinned rubric and explicit evidence allowlist used by the judge runner. */
export const judgeRecipeSchema = z.object({ judge: z.object({
  rubric: z.string().min(1), evidence_refs: z.array(z.string().min(1)).min(1),
  max_evidence_chars: z.number().int().min(1).max(32_000), target: z.enum(["report", "code"]),
}) });
export type JudgeRecipe = z.infer<typeof judgeRecipeSchema>;

export function hasJudgeRecipe(question: QuestionDefinition): boolean {
  return judgeRecipeSchema.safeParse(question.input_recipe).success;
}
export function judgeNeedsRepository(question: QuestionDefinition): boolean {
  const recipe = judgeRecipeSchema.safeParse(question.input_recipe);
  return recipe.success && recipe.data.judge.target === "code";
}
