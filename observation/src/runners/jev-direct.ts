import { z } from "zod";
import { err, ok, type JsonValue } from "../domain/primitives";
import type { GradingContext, GradingError, ProviderFailureCategory, RunnerResult } from "../grading/runner";
import type { GradeRunner } from "../ports/grade-runner";
import { gradingLimits } from "../grading/jobs/budget";

const probability = z.number().finite().min(0).max(1);
const probabilities = z.record(z.string(), probability);
export const systemOneQuestionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("choice"), instructions: z.string().min(1),
    criteria: z.record(z.string(), z.string().nullable()) }),
  z.object({ type: z.literal("score"), instructions: z.string().min(1),
    criteria: z.array(z.string().min(1)).min(2) }),
  z.object({ type: z.literal("noul"), instructions: z.string().min(1),
    criteria: z.object({ true: z.string(), false: z.string() }).optional() }),
]);
export const systemOneRecipeSchema = z.object({ system_one: systemOneQuestionSchema,
  state_fields: z.record(z.string(), z.json()).optional() });
export const systemOneRequestSchema = z.object({ model: z.string().min(1),
  state: z.record(z.string(), z.json()), questions: z.record(z.string(), systemOneQuestionSchema) });
export const systemOneAnswerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("choice"), choice: z.string(), probabilities, confidence: probability }).catchall(z.json()),
  z.object({ type: z.literal("score"), score: z.number().finite(), legend: z.record(z.string(), z.json()),
    probabilities, confidence: probability }).catchall(z.json()),
  z.object({ type: z.literal("noul"), noul: probability, probabilities: probabilities.optional(),
    confidence: probability.optional() }).catchall(z.json()),
]);
export const systemOneResponseSchema = z.object({ model: z.string().min(1),
  answers: z.record(z.string(), systemOneAnswerSchema),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }).catchall(z.json()),
  cost: z.number().finite().nonnegative().optional(),
  id: z.string().min(1).optional(), provider_link: z.url().optional() }).catchall(z.json());

export type SystemOneTransport = (url: string, init: RequestInit) => Promise<Response>;
export interface SystemOneRunnerConfig {
  readonly operation: string;
  readonly base_url: string;
  readonly api_key: string | undefined;
  readonly auth_header?: "bearer" | "x-api-key";
  readonly transport?: SystemOneTransport;
  readonly deadline_ms: number;
}

function failure(context: GradingContext, operation: string, detail: string,
  category: ProviderFailureCategory, external_execution_id?: string | null, cost?: number | null): RunnerResult {
  return err({ operation, entity_id: context.evaluator.evaluator_definition_id, detail,
    category, external_execution_id, cost } satisfies GradingError);
}

export function systemOneRequest(context: GradingContext): ReturnType<typeof systemOneRequestSchema.safeParse> {
  let instruction: unknown;
  try { instruction = JSON.parse(context.evaluator.instruction_text); }
  catch { return systemOneRequestSchema.safeParse(null); }
  const recipe = systemOneRecipeSchema.safeParse(instruction);
  if (!recipe.success || !context.evaluator.model) return systemOneRequestSchema.safeParse(null);
  const state: Record<string, JsonValue> = { ...recipe.data.state_fields };
  for (const reference of context.evidence.references) {
    if (Object.hasOwn(state, reference.ref)) return systemOneRequestSchema.safeParse(null);
    state[reference.ref] = reference.content;
  }
  return systemOneRequestSchema.safeParse({ model: context.evaluator.model, state,
    questions: { [context.question.question_id]: recipe.data.system_one } });
}

/** The question's "Choose <value> when ..." instruction designates one exact option. */
export function unclearChoice(context: GradingContext): string | null {
  const allowed = context.question.allowed_values?.filter((value): value is string => typeof value === "string") ?? [];
  const designated = /^\s*Choose\s+(.+?)\s+when\b/iu.exec(context.question.unclear_semantics)?.[1]?.trim();
  const matches = allowed.filter((value) => value === designated);
  return matches.length === 1 ? matches[0]! : null;
}

export function createSystemOneRunner(config: SystemOneRunnerConfig): GradeRunner {
  return { kind: "model", async run(context, onRequest) {
    if (!config.api_key) return failure(context, config.operation, "provider credential is not configured", "unconfigured_credential");
    const request = systemOneRequest(context);
    if (!request.success) return failure(context, config.operation, "evaluator instruction, evidence or model is invalid", "invalid_request");
    const question = request.data.questions[context.question.question_id];
    if (!question || (question.type === "choice" && context.question.response_kind !== "choice")
      || (question.type === "score" && context.question.response_kind !== "structured")
      || (question.type === "noul" && context.question.response_kind !== "numeric"))
      return failure(context, config.operation, "question response kind does not match System One type", "invalid_request");
    const unclear_choice = question.type === "choice" ? unclearChoice(context) : null;
    if (question.type === "choice" && unclear_choice === null)
      return failure(context, config.operation, "question unclear semantics must name exactly one allowed choice",
        "invalid_unclear_designation");
    let response: Response;
    const started = Date.now();
    const deadline = AbortSignal.timeout(config.deadline_ms);
    if (onRequest && !(await onRequest()))
      return failure(context, config.operation, "grading claim lost before provider request", "invalid_request");
    try {
      response = await (config.transport ?? fetch)(`${config.base_url.replace(/\/$/, "")}/systemone`, {
        method: "POST", headers: { "Content-Type": "application/json",
          ...(config.auth_header === "x-api-key" ? { "X-API-Key": config.api_key } : { Authorization: `Bearer ${config.api_key}` }) },
        body: JSON.stringify(request.data), signal: deadline,
      });
    } catch { return deadline.aborted
      ? failure(context, config.operation, "provider timeout", "timeout")
      : failure(context, config.operation, "provider transport failed", "transport"); }
    if (!response.ok) return failure(context, config.operation, `provider HTTP ${response.status}`,
      response.status === 429 ? "rate_limit" : "http_error", response.headers.get("x-request-id"));
    let raw: unknown;
    try { raw = await response.json(); }
    catch { return deadline.aborted
      ? failure(context, config.operation, "provider timeout", "timeout")
      : failure(context, config.operation, "provider response is not JSON", "invalid_response"); }
    const parsed = systemOneResponseSchema.safeParse(raw);
    if (!parsed.success) return failure(context, config.operation, "provider response does not match System One schema", "invalid_response");
    const answer = parsed.data.answers[context.question.question_id];
    if (!answer || answer.type !== question.type) return failure(context, config.operation,
      "provider answer does not match question", "invalid_response", parsed.data.id, parsed.data.cost);
    if (answer.type === "choice" && question.type === "choice") {
      if (!context.question.allowed_values?.includes(answer.choice))
        return failure(context, config.operation, "provider choice is outside question vocabulary",
          "invalid_response", parsed.data.id, parsed.data.cost);
      const options = Object.keys(question.criteria);
      if (!options.includes(answer.choice) || options.some((option) => !(option in answer.probabilities)))
        return failure(context, config.operation, "provider choice distribution omits an option",
          "invalid_response", parsed.data.id, parsed.data.cost);
    }
    const is_unclear = answer.type === "choice" && answer.choice === unclear_choice;
    const mapped = answer.type === "choice"
      ? { answer: is_unclear
        ? { state: "unclear", kind: "choice", reason: answer.choice } as const
        : { state: "answered", kind: "choice", value: answer.choice } as const,
        probabilities: answer.probabilities, confidence: answer.confidence }
      : answer.type === "score"
        ? { answer: { state: "answered", kind: "structured", value: {
          ...answer, expected_level: answer.score,
          rubric_level_distribution: Object.entries(answer.probabilities).map(([level, probability]) => ({ level, probability })),
        } } as const, probabilities: answer.probabilities, confidence: answer.confidence }
        : { answer: { state: "answered", kind: "numeric", value: answer.noul } as const,
          probabilities: answer.probabilities ?? { true: answer.noul, false: 1 - answer.noul },
          confidence: answer.confidence ?? null };
    return ok({ ...mapped, model_usage: parsed.data.usage, cost: parsed.data.cost ?? null,
      external_execution_id: parsed.data.id ?? null, provider_link: parsed.data.provider_link ?? null,
      reproducibility_metadata: { provider_model: parsed.data.model, raw_answer: answer,
        probability_provenance: answer.type === "noul" && !answer.probabilities
          ? { true: "provider_noul", false: "derived_complement" } : "provider_returned",
        latency_ms: Date.now() - started, runner: config.operation } });
  } };
}

export interface JevDirectConfig {
  readonly api_key: string | undefined;
  readonly base_url: string;
  readonly transport?: SystemOneTransport;
  readonly deadline_ms?: number;
}
export function createJevDirectRunner(config: JevDirectConfig): GradeRunner {
  return createSystemOneRunner({ operation: "jev_direct", ...config,
    deadline_ms: config.deadline_ms ?? gradingLimits().provider_deadline_ms });
}
