import type { JsonValue, Result } from "../domain/primitives";
import type { EvidenceSet } from "./evidence";
import type { EvaluatorDefinition } from "./evaluator";
import type { GradeAnswer } from "./observation";
import type { QuestionDefinition } from "./question";

export type ProviderFailureCategory = "unconfigured_credential" | "invalid_request" | "invalid_unclear_designation" | "invalid_choice"
  | "invalid_response" | "rate_limit" | "timeout" | "transport" | "http_error";
export interface GradingError { readonly operation: string; readonly entity_id: string; readonly detail: string;
  readonly category?: ProviderFailureCategory;
  readonly external_execution_id?: string | null; readonly cost?: number | null }
export interface GradingContext {
  readonly question: QuestionDefinition;
  readonly evidence: EvidenceSet;
  readonly evaluator: EvaluatorDefinition;
}
export interface EvaluationOutcome {
  readonly answer: GradeAnswer;
  readonly probabilities?: Readonly<Record<string, number>> | null;
  readonly confidence?: number | null;
  readonly model_usage?: JsonValue | null;
  readonly cost?: number | null;
  readonly external_execution_id?: string | null;
  readonly provider_link?: string | null;
  readonly reproducibility_metadata?: JsonValue | null;
  readonly comments?: string | null;
  readonly rationale?: string | null;
  readonly quality_flags?: readonly string[];
}
export type RunnerResult = Result<EvaluationOutcome, GradingError>;
