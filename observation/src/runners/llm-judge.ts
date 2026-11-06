import { z } from "zod";
import { err, ok } from "../domain/primitives";
import type { GradingContext, RunnerResult } from "../grading/runner";
import type { GradeRunner } from "../ports/grade-runner";

export const judgeAnswerSchema = z.object({ choice: z.string().min(1),
  probabilities: z.record(z.string(), z.number().finite().min(0).max(1)),
  confidence: z.number().finite().min(0).max(1), explanation: z.string().optional() });
const completionSchema = z.object({ id: z.string().min(1), model: z.string().min(1),
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
  usage: z.object({ prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(), total_tokens: z.number().int().nonnegative() }).optional() });

/** The judge's pinned rubric lives in its evaluator's instruction text, as JSON. */
export const judgeInstructionSchema = z.object({ rubric: z.string().min(1),
  max_evidence_chars: z.number().int().min(1).max(32_000) });

export type JudgeTransport = (url: string, init: RequestInit) => Promise<Response>;
export interface JudgeConfig { readonly api_key: string | undefined; readonly base_url: string;
  readonly transport?: JudgeTransport; readonly deadline_ms?: number }
function failure(context: GradingContext, detail: string, category: import("../grading/runner").ProviderFailureCategory,
  external_execution_id?: string | null): RunnerResult {
  return err({ operation: "llm_judge", entity_id: context.evaluator.evaluator_definition_id, detail,
    category, external_execution_id });
}

function parsedInstruction(text: string): z.infer<typeof judgeInstructionSchema> | null {
  try {
    const parsed = judgeInstructionSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

/** A single atomic, pinned rubric over the frozen evidence, within a pinned size bound. */
export function createLlmJudgeRunner(config: JudgeConfig): GradeRunner {
  return { kind: "model", async run(context, onRequest) {
    if (!config.api_key) return failure(context, "judge credential is not configured", "unconfigured_credential");
    if (!context.evaluator.model || context.question.response_kind !== "choice")
      return failure(context, "judge requires a pinned model and choice question", "invalid_request");
    const values = context.question.allowed_values;
    if (!values || !values.every((value): value is string => typeof value === "string")
      || !values.includes("unclear"))
      return failure(context, "judge question requires an explicit unclear choice", "invalid_choice");
    const instruction = parsedInstruction(context.evaluator.instruction_text);
    if (!instruction) return failure(context, "judge instruction is invalid", "invalid_request");
    const evidence = JSON.stringify(context.evidence.references.map(({ ref, content }) => ({ ref, content })));
    if (evidence.length > instruction.max_evidence_chars)
      return failure(context, "judge evidence exceeds its pinned bound", "invalid_request");
    const prompt = { rubric: instruction.rubric, allowed_values: values, evidence,
      instruction: "Return JSON with choice, probabilities for every allowed value, confidence and optional explanation. Do not infer correctness from an explanation." };
    let response: Response;
    const started = Date.now();
    const deadline = AbortSignal.timeout(config.deadline_ms ?? 30_000);
    if (onRequest && !(await onRequest()))
      return failure(context, "grading claim lost before provider request", "invalid_request");
    try { response = await (config.transport ?? fetch)(`${config.base_url.replace(/\/$/, "")}/chat/completions`, {
      method: "POST", signal: deadline, headers: { Authorization: `Bearer ${config.api_key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: context.evaluator.model, temperature: 0, response_format: { type: "json_object" },
        messages: [{ role: "user", content: JSON.stringify(prompt) }] }),
    }); } catch { return failure(context, deadline.aborted ? "judge timeout" : "judge transport failed",
      deadline.aborted ? "timeout" : "transport"); }
    if (!response.ok) return failure(context, `judge HTTP ${response.status}`,
      response.status === 429 ? "rate_limit" : "http_error", response.headers.get("x-request-id"));
    let raw: unknown;
    try { raw = await response.json(); } catch { return failure(context,
      deadline.aborted ? "judge timeout" : "judge response is not JSON",
      deadline.aborted ? "timeout" : "invalid_response"); }
    const completion = completionSchema.safeParse(raw);
    if (!completion.success) return failure(context, "judge completion does not match expected schema", "invalid_response");
    let content: unknown;
    try { content = JSON.parse(completion.data.choices[0]!.message.content); }
    catch { return failure(context, "judge answer is not JSON", "invalid_response"); }
    const answer = judgeAnswerSchema.safeParse(content);
    if (!answer.success || !values.includes(answer.data.choice)
      || values.some((value) => !(value in answer.data.probabilities)))
      return failure(context, "judge answer does not match question choices", "invalid_response");
    return ok({ answer: answer.data.choice === "unclear"
      ? { state: "unclear", kind: "choice", reason: answer.data.choice }
      : { state: "answered", kind: "choice", value: answer.data.choice },
      probabilities: answer.data.probabilities, confidence: answer.data.confidence,
      rationale: answer.data.explanation ?? null, model_usage: completion.data.usage ?? null,
      external_execution_id: completion.data.id,
      reproducibility_metadata: { provider_model: completion.data.model,
        explanation_source: { provider: context.evaluator.provider, model: context.evaluator.model,
          runtime_revision: context.evaluator.runtime_revision }, raw_answer: answer.data,
        latency_ms: Date.now() - started } });
  } };
}

export const llmJudgeRunner = createLlmJudgeRunner({ api_key: process.env.OBSERVATION_LLM_JUDGE_API_KEY,
  base_url: process.env.OBSERVATION_LLM_JUDGE_BASE_URL ?? "https://api.openai.com/v1" });
