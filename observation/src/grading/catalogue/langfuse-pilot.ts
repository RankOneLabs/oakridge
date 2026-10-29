import type { QuestionId } from "../../domain/identity";
import type { QuestionDefinition } from "../question";
import { PILOT_EVIDENCE_RECIPES, pinnedInputRecipe, type PilotQuestionId } from "../../langfuse/evidence-recipe";

export interface PilotQuestion { readonly definition: QuestionDefinition; readonly text: string }

const relevance: QuestionDefinition = {
  question_id: "analysis.finding_relevance" as QuestionId, question_version: "v1", target_item_kinds: ["finding"],
  input_recipe: pinnedInputRecipe(PILOT_EVIDENCE_RECIPES["analysis.finding_relevance"]),
  response_kind: "choice", allowed_values: ["relevant", "irrelevant", "unclear_insufficient_evidence"],
  missing_evidence_policy: "abstain",
  abstain_semantics: "Abstain only when the pinned requested change or excerpt is unavailable; low confidence alone is not abstention.",
  unclear_semantics: "Choose unclear_insufficient_evidence when the available excerpt does not support a relevance decision; preserve disagreement between graders separately.",
  interpretation_caveats: "Judge one analysis finding against the original requested change and its relevant excerpt, not the whole analysis body.",
  requires_repository_snapshot: false,
};
const traceability: QuestionDefinition = {
  question_id: "plan.criterion_traceability" as QuestionId, question_version: "v1", target_item_kinds: ["criterion"],
  input_recipe: pinnedInputRecipe(PILOT_EVIDENCE_RECIPES["plan.criterion_traceability"]),
  response_kind: "choice", allowed_values: ["traceable", "unsupported", "unclear_insufficient_evidence"],
  missing_evidence_policy: "abstain",
  abstain_semantics: "Abstain only when the tasks or plan revision that should hold a cited id was not captured; a cited id absent from a captured revision is a dangling citation and is excluded before grading.",
  unclear_semantics: "Choose unclear_insufficient_evidence when every cited source is present but the bounded excerpts do not settle whether the criterion follows from them.",
  interpretation_caveats: "Judge one plan criterion only against the tasks and decisions it cites, not the whole plan, analysis or task list. Added implementation detail is not unsupported; only scope or a requirement no cited source supports is.",
  requires_repository_snapshot: false,
};
const fidelity: QuestionDefinition = {
  question_id: "brief.source_fidelity" as QuestionId, question_version: "v1", target_item_kinds: ["criterion"],
  input_recipe: pinnedInputRecipe(PILOT_EVIDENCE_RECIPES["brief.source_fidelity"]),
  response_kind: "choice", allowed_values: ["faithful", "changed_meaning", "unclear_insufficient_evidence"],
  missing_evidence_policy: "abstain",
  abstain_semantics: "Abstain when either criterion source is unavailable; do not infer abstention from a flat distribution.",
  unclear_semantics: "Choose unclear_insufficient_evidence when both criteria are present but their relationship cannot be judged from the bounded evidence.",
  interpretation_caveats: "Pair plan and brief criteria by the unchanged cohort criterion id and derived_from link; rewording does not create a new item.",
  requires_repository_snapshot: false,
};
const coverage: QuestionDefinition = {
  question_id: "assessment.coverage" as QuestionId, question_version: "v1", target_item_kinds: ["criterion"],
  input_recipe: pinnedInputRecipe(PILOT_EVIDENCE_RECIPES["assessment.coverage"]),
  response_kind: "boolean", allowed_values: null, missing_evidence_policy: "fail",
  abstain_semantics: "No answer is recorded when the brief criterion or assessment selection is unavailable; zero covering findings is a negative answer.",
  unclear_semantics: "Link absence is not unknown: an unset criterion_id means no assesses link, never an inferred match.",
  interpretation_caveats: "Only a brief criterion with zero assessment findings linked by assesses is a coverage miss. An assessment finding without criterion_id is not itself a miss.",
  requires_repository_snapshot: false,
};

/** Four independently versioned questions, one per stage, pinned to Oakridge's selected item kinds. */
export const LANGFUSE_PILOT_QUESTIONS: Readonly<Record<PilotQuestionId, PilotQuestion>> = {
  "analysis.finding_relevance": { definition: relevance, text: "Is this analysis finding relevant to the originally requested change?" },
  "plan.criterion_traceability": { definition: traceability, text: "Does this plan criterion follow from the tasks and decisions it cites?" },
  "brief.source_fidelity": { definition: fidelity, text: "Does this brief criterion preserve the meaning of its identified plan criterion?" },
  "assessment.coverage": { definition: coverage, text: "Does at least one assessment finding explicitly assess this brief criterion?" },
};
