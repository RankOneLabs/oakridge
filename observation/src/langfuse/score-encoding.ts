import { err, ok, type JsonValue, type Result } from "../domain/primitives";
import type { EvaluationOutcome, GradingError } from "../grading/runner";

export interface JevRubricLevel { readonly level: number; readonly probability: number }
export interface JevScore {
  readonly expected_level: number;
  readonly rubric_level_distribution: readonly JevRubricLevel[];
}
export interface JevScorePayload extends JevScore {
  readonly probabilities: Readonly<Record<string, number>>;
}

/** Keep the fractional expectation, every rubric level, and probabilities as a structured raw answer. */
export function encodeJevScore(score: JevScore): Result<EvaluationOutcome, GradingError> {
  const invalid = (detail: string) => err({ operation: "encode_jev_score", entity_id: "jev.score", detail });
  const levels = score.rubric_level_distribution;
  if (levels.length === 0 || !Number.isFinite(score.expected_level)) return invalid("score requires a finite expected level and distribution");
  const probabilities: Record<string, number> = {};
  let total = 0;
  for (const { level, probability } of levels) {
    if (!Number.isSafeInteger(level) || !Number.isFinite(probability) || probability < 0 || probability > 1)
      return invalid("rubric levels must be integers with probabilities in [0, 1]");
    const label = String(level);
    if (label in probabilities) return invalid("rubric levels must be unique");
    probabilities[label] = probability;
    total += probability;
  }
  if (Math.abs(total - 1) > 1e-9) return invalid("rubric probabilities must sum to one");
  const values = levels.map(({ level }) => level);
  if (score.expected_level < Math.min(...values) || score.expected_level > Math.max(...values))
    return invalid("expected level lies outside the rubric");
  const value: JevScorePayload = { expected_level: score.expected_level,
    rubric_level_distribution: levels.map(({ level, probability }) => ({ level, probability })), probabilities };
  return ok({ answer: { state: "answered", kind: "structured", value: value as unknown as JsonValue }, probabilities });
}
