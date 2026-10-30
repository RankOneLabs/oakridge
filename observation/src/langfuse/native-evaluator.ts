import { canonicalDigest } from "../canonical/canonical-json";
import { err, ok, type Result } from "../domain/primitives";
import type { EvaluatorDefinition } from "../grading/evaluator";
import type { EvaluationIdentity } from "../grading/execution";
import type { LangfuseError } from "../ports/evaluation-backend";
import type { PilotPackage } from "./run-packages";

/** Every native projection of a package is the same attempt, so a re-run replays it. */
export const NATIVE_ATTEMPT_LABEL = "langfuse-native";

/** A Langfuse-run Jev evaluator for one question. The local execution stays running until its score arrives. */
export function nativeJevEvaluator(question_id: string, question_version: string, question_text: string,
  model: string): Result<EvaluatorDefinition, LangfuseError> {
  const prompt = canonicalDigest(question_text);
  const config = canonicalDigest({ question_id, question_version, model, runtime: "langfuse_evaluation_rule" });
  if (!prompt.ok || !config.ok)
    return err({ operation: "native_evaluator", entity_id: question_id, detail: "evaluator identity is not canonical" });
  return ok({ evaluator_definition_id: `langfuse-native-jev:${question_id}@${question_version}`, kind: "model",
    backend_kind: "langfuse_native", provider: "typesafe", model, prompt_digest: prompt.value,
    config_digest: config.value, runtime_revision: "langfuse-cloud", cost_metadata: null, seed: null,
    attempt_controls: null });
}

export function nativeIdentity(pilot: PilotPackage, evaluator: EvaluatorDefinition, question_version: string): EvaluationIdentity {
  return { subject_occurrence_id: pilot.subject.occurrence_id, evidence_set_id: pilot.evidence.evidence_set_id,
    question_id: pilot.question_id as EvaluationIdentity["question_id"], question_version,
    evaluator_definition_id: evaluator.evaluator_definition_id, config_digest: evaluator.config_digest,
    attempt_label: NATIVE_ATTEMPT_LABEL };
}
