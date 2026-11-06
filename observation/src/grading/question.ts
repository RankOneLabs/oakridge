import type { JsonValue } from "../domain/primitives";
import type { QuestionId } from "../domain/identity";

export type ResponseKind = "boolean" | "choice" | "ordinal" | "numeric" | "text" | "structured";
export interface QuestionDefinition {
  readonly question_id: QuestionId;
  readonly question_version: string;
  readonly question_text?: string | null;
  readonly item_kind: string;
  readonly response_kind: ResponseKind;
  readonly allowed_values: readonly JsonValue[] | null;
  readonly missing_evidence_policy: "fail" | "abstain";
  readonly abstain_semantics: string;
  readonly unclear_semantics: string;
  readonly interpretation_caveats: string;
}
