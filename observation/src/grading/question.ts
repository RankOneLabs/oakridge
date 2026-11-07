import type { JsonValue } from "../domain/primitives";
import type { QuestionId } from "../domain/identity";

export type ResponseKind = "boolean" | "choice" | "ordinal" | "numeric" | "text" | "structured";

/** The immutable key an occurrence pins and an execution measures. */
export interface QuestionKey {
  readonly question_id: QuestionId;
  readonly question_version: string;
}

/** Mirrors observation.question_definition: versioned wording, one item kind, its answers. */
export interface QuestionDefinition extends QuestionKey {
  readonly item_kind: string;
  readonly question_text: string | null;
  readonly response_kind: ResponseKind;
  readonly allowed_values: readonly JsonValue[] | null;
  readonly missing_evidence_policy: "fail" | "abstain";
  readonly abstain_semantics: string;
  readonly unclear_semantics: string;
  readonly interpretation_caveats: string;
}
