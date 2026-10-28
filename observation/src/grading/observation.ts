import type { GradeObservationId } from "../domain/identity";
import type { JsonValue } from "../domain/primitives";
import type { ResponseKind } from "./question";

export type GradeAnswer =
  | { readonly state: "answered"; readonly kind: "boolean"; readonly value: boolean }
  | { readonly state: "answered"; readonly kind: "choice"; readonly value: string }
  | { readonly state: "answered"; readonly kind: "ordinal"; readonly value: string }
  | { readonly state: "answered"; readonly kind: "numeric"; readonly value: number }
  | { readonly state: "answered"; readonly kind: "text"; readonly value: string }
  | { readonly state: "answered"; readonly kind: "structured"; readonly value: JsonValue }
  | { readonly state: "abstain" | "unclear"; readonly kind: ResponseKind; readonly reason: string };
export interface GradeObservation {
  readonly observation_id: GradeObservationId;
  readonly answer: GradeAnswer;
  readonly probabilities: Readonly<Record<string, number>> | null;
  readonly confidence: number | null;
  readonly normalized_score: number | null;
  readonly decision_policy_id: string | null;
  readonly decision_policy_version: string | null;
  readonly reviewer_id: string | null;
  readonly reviewer_details: JsonValue | null;
  readonly comments: string | null;
  readonly rationale: string | null;
  readonly quality_flags: readonly string[];
  readonly supersedes_observation_id: GradeObservationId | null;
}
