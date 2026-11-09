// Generated from observation/src/http/grading-api.ts. Run bun kbbl/scripts/generate-grading-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

import type { ObservationQuestionId } from "../domain/identity";
import type { ObservationJsonValue } from "../domain/primitives";

export interface ObservationQuestionKey {
  readonly question_id: ObservationQuestionId;
  readonly question_version: string;
}

export interface ObservationQuestionDefinition extends ObservationQuestionKey {
  readonly item_kind: string;
  readonly question_text: string | null;
  readonly response_kind: ObservationResponseKind;
  readonly allowed_values: readonly ObservationJsonValue[] | null;
  readonly missing_evidence_policy: "fail" | "abstain";
  readonly abstain_semantics: string;
  readonly unclear_semantics: string;
  readonly interpretation_caveats: string;
}

export type ObservationResponseKind = "boolean" | "choice" | "ordinal" | "numeric" | "text" | "structured";
