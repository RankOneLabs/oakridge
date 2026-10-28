import { canonicalDigest } from "../canonical/canonical-json";
import type { JsonValue, Result } from "../domain/primitives";
import type { CanonicalizationError } from "../domain/errors";

export type EvaluatorKind = "model" | "code" | "human";
export interface EvaluatorDefinition {
  readonly evaluator_definition_id: string;
  readonly kind: EvaluatorKind;
  readonly backend_kind: string;
  readonly provider: string;
  readonly model: string | null;
  readonly prompt_digest: string;
  readonly config_digest: string;
  readonly runtime_revision: string;
  readonly cost_metadata: JsonValue | null;
  readonly seed: number | null;
  readonly attempt_controls: JsonValue | null;
}
export function evaluatorIdentity(definition: EvaluatorDefinition): Result<string, CanonicalizationError> {
  return canonicalDigest([definition.kind, definition.backend_kind, definition.provider, definition.model,
    definition.prompt_digest, definition.config_digest, definition.runtime_revision]);
}
