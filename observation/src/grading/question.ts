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
