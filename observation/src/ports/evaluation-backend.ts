import type { EvaluationExecution } from "../grading/execution";

/** Optional mirror for external evaluation systems. The local store remains authoritative. */
export interface EvaluationBackend {
  record(execution: EvaluationExecution): Promise<void>;
}
export class LocalEvaluationBackend implements EvaluationBackend {
  async record(_execution: EvaluationExecution): Promise<void> { /* local grading store already records it */ }
}
