import { z } from "zod";
import { err, ok, type Result } from "../domain/primitives";
import type { QuestionDefinition } from "../grading/question";
import type { LangfuseError } from "../ports/evaluation-backend";
import type { LangfuseHttpClient } from "./http-client";

/** Langfuse CreateScoreConfigRequest, pinned to the public OpenAPI contract. */
export const scoreConfigRequestSchema = z.object({
  name: z.string().min(1).max(80).regex(/^[\w .()-]+$/),
  dataType: z.enum(["CATEGORICAL", "BOOLEAN", "NUMERIC"]),
  categories: z.array(z.object({ label: z.string().min(1), value: z.number().finite() })).nullable(),
  minValue: z.number().finite().nullable(), maxValue: z.number().finite().nullable(),
  description: z.string().min(1),
}).superRefine((body, context) => {
  if (body.dataType === "CATEGORICAL" && (!body.categories?.length || body.minValue !== null || body.maxValue !== null))
    context.addIssue({ code: "custom", message: "categorical config requires categories only" });
  if (body.dataType !== "CATEGORICAL" && body.categories !== null)
    context.addIssue({ code: "custom", message: "only categorical configs accept categories" });
  if (body.minValue !== null && body.maxValue !== null && body.minValue > body.maxValue)
    context.addIssue({ code: "custom", message: "numeric range is reversed" });
});

export type ScoreConfigRequest = z.infer<typeof scoreConfigRequestSchema>;
export type ScoreValueDomain =
  | { readonly kind: "categorical"; readonly allowed_values: readonly string[] }
  | { readonly kind: "boolean"; readonly allowed_values: readonly [false, true] }
  | { readonly kind: "numeric"; readonly min_value: number; readonly max_value: number };
export interface ScoreConfig {
  readonly name: string;
  readonly question_id: QuestionDefinition["question_id"];
  readonly question_version: string;
  readonly value_domain: ScoreValueDomain;
  readonly instructions: string;
  readonly abstain_semantics: string;
  readonly unclear_semantics: string;
  readonly request: ScoreConfigRequest;
}

/** Langfuse config names forbid '@'; the pair remains explicit and unambiguous. */
export function scoreConfigName(question_id: string, question_version: string): string {
  return `${question_id}.${question_version}`;
}

/** The three pinned pilot recipes grade report artifacts, not repository code. */
export function pilotGradedArtifact(question_id: string, question_version: string): "report" | null {
  if (question_version !== "v1") return null;
  return ["analysis.finding_relevance", "brief.source_fidelity", "assessment.coverage"].includes(question_id)
    ? "report" : null;
}

function failure(question: QuestionDefinition, detail: string): Result<never, LangfuseError> {
  return err({ operation: "score_config", entity_id: question.question_id, detail });
}

/** The category labels are the service answer values; numeric category IDs are Langfuse's wire representation. */
export function scoreConfigFromQuestion(question: QuestionDefinition, question_text: string): Result<ScoreConfig, LangfuseError> {
  if (!question_text.trim()) return failure(question, "question wording is required");
  const name = scoreConfigName(question.question_id, question.question_version);
  const graded_artifact = pilotGradedArtifact(question.question_id, question.question_version);
  const instructions = `${question_text}\n${graded_artifact ? `Graded artifact: ${graded_artifact}\n` : ""}${question.interpretation_caveats}\nAbstain: ${question.abstain_semantics}\nUnclear: ${question.unclear_semantics}`;
  let value_domain: ScoreValueDomain;
  let request: ScoreConfigRequest;
  if (question.response_kind === "choice" || question.response_kind === "ordinal") {
    const labels = question.allowed_values;
    if (!labels?.length || !labels.every((label) => typeof label === "string" && label.length > 0)
      || new Set(labels).size !== labels.length) return failure(question, "categorical allowed_values must be unique nonempty strings");
    value_domain = { kind: "categorical", allowed_values: labels as string[] };
    request = { name, dataType: "CATEGORICAL", categories: (labels as string[]).map((label, value) => ({ label, value })),
      minValue: null, maxValue: null, description: instructions };
  } else if (question.response_kind === "boolean") {
    if (question.allowed_values !== null && JSON.stringify(question.allowed_values) !== JSON.stringify([false, true]))
      return failure(question, "boolean allowed_values must be null or [false,true]");
    value_domain = { kind: "boolean", allowed_values: [false, true] };
    request = { name, dataType: "BOOLEAN", categories: null, minValue: null, maxValue: null, description: instructions };
  } else if (question.response_kind === "numeric") {
    const bounds = question.allowed_values;
    if (!bounds || bounds.length !== 2 || !bounds.every((value) => typeof value === "number" && Number.isFinite(value)))
      return failure(question, "numeric question requires [minimum, maximum] allowed_values");
    const [min_value, max_value] = bounds as number[];
    if (min_value! > max_value!) return failure(question, "numeric range is reversed");
    value_domain = { kind: "numeric", min_value: min_value!, max_value: max_value! };
    request = { name, dataType: "NUMERIC", categories: null, minValue: min_value!, maxValue: max_value!, description: instructions };
  } else return failure(question, "question response kind cannot be represented by a Langfuse score config");
  const parsed = scoreConfigRequestSchema.safeParse(request);
  return parsed.success ? ok({ name, question_id: question.question_id, question_version: question.question_version,
    value_domain, instructions, abstain_semantics: question.abstain_semantics,
    unclear_semantics: question.unclear_semantics, request: parsed.data })
    : failure(question, "score config request does not match Langfuse API");
}

const createdSchema = z.object({ id: z.string().min(1), name: z.string().min(1),
  dataType: z.enum(["CATEGORICAL", "BOOLEAN", "NUMERIC"]), projectId: z.string().min(1) });

export async function createScoreConfig(client: LangfuseHttpClient, config: ScoreConfig): Promise<Result<string, LangfuseError>> {
  const body = scoreConfigRequestSchema.safeParse(config.request);
  if (!body.success) return err({ operation: "create_score_config", entity_id: config.name,
    detail: "score config request does not match Langfuse API" });
  const created = await client.request({ operation: "create_score_config", entity_id: config.name,
    method: "POST", path: "/api/public/score-configs", body: body.data, response: createdSchema });
  if (!created.ok) return created;
  if (created.value.name !== config.name || created.value.dataType !== body.data.dataType)
    return err({ operation: "create_score_config", entity_id: config.name, detail: "created config differs from question" });
  return ok(created.value.id);
}
