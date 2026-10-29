import { z } from "zod";
import { err, type Result } from "../domain/primitives";
import type { GradeAnswer } from "../grading/observation";
import type { LangfuseError } from "../ports/evaluation-backend";
import type { LangfuseHttpClient } from "./http-client";

export interface ModelScoreInput {
  readonly score_id: string;
  readonly trace_id: string;
  readonly external_observation_id: string;
  readonly question_id: string;
  readonly question_version: string;
  readonly evaluator_definition_id: string;
  readonly provider: string;
  readonly model: string;
  readonly answer: GradeAnswer;
  readonly probabilities: Readonly<Record<string, number>> | null;
  readonly confidence: number | null;
}

const responseSchema = z.object({ id: z.string().min(1) });
const expectedLevelSchema = z.object({ expected_level: z.number().finite() });
export const RAW_SCORE_MAPPING_VERSION = "raw-model-answer/v1";

/** A Langfuse score is a labelled raw reading; local policy fields remain null. */
export async function ingestModelScore(client: LangfuseHttpClient,
  input: ModelScoreInput): Promise<Result<string, LangfuseError>> {
  let value: string | number;
  let dataType: "CATEGORICAL" | "NUMERIC";
  if (input.answer.state !== "answered") {
    value = input.answer.reason;
    dataType = "CATEGORICAL";
  } else if (input.answer.kind === "choice") {
    value = input.answer.value;
    dataType = "CATEGORICAL";
  } else if (input.answer.kind === "numeric") {
    value = input.answer.value;
    dataType = "NUMERIC";
  } else if (input.answer.kind === "structured") {
    const parsed = expectedLevelSchema.safeParse(input.answer.value);
    if (!parsed.success) return err({ operation: "ingest_model_score", entity_id: input.score_id,
      detail: "structured answer has no raw expected level" });
    value = parsed.data.expected_level;
    dataType = "NUMERIC";
  } else return err({ operation: "ingest_model_score", entity_id: input.score_id,
    detail: "model answer has no raw score representation" });
  const result = await client.request({ operation: "ingest_model_score", entity_id: input.score_id,
    method: "POST", path: "/api/public/scores", response: responseSchema,
    body: { id: input.score_id, traceId: input.trace_id, observationId: input.external_observation_id,
      name: `${input.question_id}@${input.question_version}/raw`, value, dataType, source: "API",
      metadata: { score_mapping_version: RAW_SCORE_MAPPING_VERSION,
        evaluator_definition_id: input.evaluator_definition_id, provider: input.provider, model: input.model,
        raw_answer: input.answer, probabilities: input.probabilities, confidence: input.confidence,
        normalized: false } } });
  return result.ok ? { ok: true, value: result.value.id } : result;
}
