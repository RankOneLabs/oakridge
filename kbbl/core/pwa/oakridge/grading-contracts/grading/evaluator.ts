// Generated from observation/src/http/grading-api.ts. Run bun kbbl/scripts/generate-grading-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

import type { ObservationJsonValue } from "../domain/primitives";

export interface ObservationEvaluatorDefinition {
  readonly evaluator_definition_id: string;
  readonly kind: ObservationEvaluatorKind;
  readonly backend_kind: string;
  readonly provider: string;
  readonly model: string | null;
  readonly prompt_digest: string;
  readonly instruction_text: string;
  readonly config_digest: string;
  readonly runtime_revision: string;
  readonly cost_metadata: ObservationJsonValue | null;
  readonly seed: number | null;
  readonly attempt_controls: ObservationJsonValue | null;
}

export type ObservationEvaluatorKind = "model" | "code" | "human";
