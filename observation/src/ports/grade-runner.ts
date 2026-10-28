import type { GradingContext, RunnerResult } from "../storage/grading-store";
import type { EvaluatorKind } from "../grading/evaluator";

export interface GradeRunner {
  readonly kind: EvaluatorKind;
  run(context: GradingContext): Promise<RunnerResult>;
}
