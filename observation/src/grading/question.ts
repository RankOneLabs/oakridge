import type { JsonValue } from "../domain/primitives";
import type { QuestionId } from "../domain/identity";

export type ResponseKind = "boolean" | "choice" | "ordinal" | "numeric" | "text" | "structured";
/** Identity of the authored workflow and target artifact schema this question supports. */
export interface PinnedExpectation {
  readonly definition_id: string;
  readonly artifact_schema_version: string;
}

export interface QuestionDefinition {
  readonly question_id: QuestionId;
  readonly question_version: string;
  readonly question_text?: string | null;
  readonly pinned_expectation: PinnedExpectation;
  readonly target_item_kinds: readonly string[];
  readonly input_recipe: { readonly [key: string]: JsonValue };
  readonly response_kind: ResponseKind;
  readonly allowed_values: readonly JsonValue[] | null;
  readonly missing_evidence_policy: "fail" | "abstain";
  readonly abstain_semantics: string;
  readonly unclear_semantics: string;
  readonly interpretation_caveats: string;
  readonly requires_repository_snapshot: boolean;
}

export function isCriterionItemKind(item_kind: string): boolean {
  return ["criterion", "plan_wide_criterion"].includes(item_kind);
}

/** Retired questions remain registered for immutable historical readback. */
export function gradingSubjectRefusal(item_kind: string, question_id: string, question_version: string): string | null {
  if (isCriterionItemKind(item_kind)) return "criterion is an obligation/reference entity, not a grading subject";
  if (question_version === "v1" && ["plan.criterion_traceability", "brief.source_fidelity", "assessment.coverage"].includes(question_id))
    return "legacy criterion-targeting question is excluded from new grading";
  return null;
}
