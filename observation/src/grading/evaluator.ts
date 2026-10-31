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
  readonly instruction_text: string;
  readonly config_digest: string;
  readonly runtime_revision: string;
  readonly cost_metadata: JsonValue | null;
  readonly seed: number | null;
  readonly attempt_controls: JsonValue | null;
}
export function instructionDigest(text: string): string {
  const digest = canonicalDigest(text);
  if (!digest.ok) throw new Error(digest.error.detail);
  return digest.value;
}
export function evaluatorIdentity(definition: EvaluatorDefinition): Result<string, CanonicalizationError> {
  return canonicalDigest([definition.kind, definition.backend_kind, definition.provider, definition.model,
    definition.prompt_digest, definition.config_digest, definition.runtime_revision]);
}

/** The imported-annotation evaluator identities, oldest first.
 *
 * v2 carries the instruction text and its canonical digest. v1 rows written before migration
 * 0010 hold the literal config string as their prompt digest and no instruction text, and 0010
 * leaves them untouched, so new imports register under v2 rather than conflict with them.
 * Both ids stay reserved for the authenticated import path, both count as blind imported
 * annotations, and migration 0014 makes the generated label origin recognise both. */
export const LANGFUSE_ANNOTATION_EVALUATOR_IDS = ["langfuse-annotation-human",
  "langfuse-annotation-human/v2"] as const;
export const LANGFUSE_ANNOTATION_EVALUATOR_ID = "langfuse-annotation-human/v2";
export const isLangfuseAnnotationEvaluator = (evaluator_definition_id: string): boolean =>
  (LANGFUSE_ANNOTATION_EVALUATOR_IDS as readonly string[]).includes(evaluator_definition_id);

/** Service-owned definition for native reviewer submissions. */
const NATIVE_HUMAN_CONFIG = {
  kind: "human", backend_kind: "local", provider: "oakridge", model: null,
  instruction_text: "Native human review", runtime_revision: "1",
} as const;
const nativeHumanConfigDigest = canonicalDigest(NATIVE_HUMAN_CONFIG);
if (!nativeHumanConfigDigest.ok) throw new Error(nativeHumanConfigDigest.error.detail);
export const NATIVE_HUMAN_EVALUATOR: EvaluatorDefinition = {
  evaluator_definition_id: "oakridge-native-human/v1", ...NATIVE_HUMAN_CONFIG,
  prompt_digest: instructionDigest(NATIVE_HUMAN_CONFIG.instruction_text),
  config_digest: nativeHumanConfigDigest.value,
  cost_metadata: null, seed: null, attempt_controls: null,
};
