import type { GradeRunner } from "../ports/grade-runner";
import type { EvaluationOutcome } from "../grading/runner";

/** Replay fixture: the evaluator definition pins both answer and distribution. */
export const stubModelRunner: GradeRunner = {
  kind: "model",
  async run(context) {
    const controls = context.evaluator.attempt_controls;
    if (!controls || typeof controls !== "object" || Array.isArray(controls) || !("answer" in controls))
      return { ok: false, error: { operation: "stub_model", entity_id: context.evaluator.evaluator_definition_id,
        detail: "attempt controls require a pinned answer" } };
    const answer = controls.answer as EvaluationOutcome["answer"];
    const probabilities = "probabilities" in controls ? controls.probabilities as EvaluationOutcome["probabilities"] : null;
    return { ok: true, value: { answer, probabilities, reproducibility_metadata: { runner: "stub-model/v1" } } };
  },
};
