import type { GradingContext, RunnerResult } from "../grading/runner";
import type { EvaluatorKind } from "../grading/evaluator";

export interface GradeRunner {
  readonly kind: EvaluatorKind;
  run(context: GradingContext): Promise<RunnerResult>;
}
