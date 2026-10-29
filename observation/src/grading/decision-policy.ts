import type { GradeAnswer } from "./observation";

/** Normalization is opt-in; policy versions never rewrite recorded answers. */
export interface DecisionPolicy {
  readonly policy_id: string;
  readonly policy_version: string;
  normalize(answer: GradeAnswer): number | null;
}
