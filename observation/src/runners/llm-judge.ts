import { z } from "zod";
import { err, ok } from "../domain/primitives";
import type { GradingContext, RunnerResult } from "../grading/runner";
import type { GradeRunner } from "../ports/grade-runner";

const judgeRecipeSchema = z.object({ judge: z.object({
  rubric: z.string().min(1), evidence_refs: z.array(z.string().min(1)).min(1),
  max_evidence_chars: z.number().int().min(1).max(32_000), target: z.enum(["report", "code"]),
}) });
export const judgeAnswerSchema = z.object({ choice: z.string().min(1),
  probabilities: z.record(z.string(), z.number().finite().min(0).max(1)),
  confidence: z.number().finite().min(0).max(1), explanation: z.string().optional() });
const completionSchema = z.object({ id: z.string().min(1), model: z.string().min(1),
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
  usage: z.object({ prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(), total_tokens: z.number().int().nonnegative() }).optional() });

export type JudgeTransport = (url: string, init: RequestInit) => Promise<Response>;
export interface JudgeConfig { readonly api_key: string | undefined; readonly base_url: string;
  readonly transport?: JudgeTransport; readonly deadline_ms?: number }
function failure(context: GradingContext, detail: string, external_execution_id?: string | null): RunnerResult {
  return err({ operation: "llm_judge", entity_id: context.evaluator.evaluator_definition_id, detail,
    external_execution_id });
}

/** A single atomic, pinned rubric over an explicit, bounded evidence allowlist. */
export function createLlmJudgeRunner(config: JudgeConfig): GradeRunner {
  return { kind: "model", async run(context) {
    if (!config.api_key) return failure(context, "judge credential is not configured");
    if (!context.evaluator.model || context.question.response_kind !== "choice")
      return failure(context, "judge requires a pinned model and choice question");
    const values = context.question.allowed_values;
    if (!values || !values.every((value): value is string => typeof value === "string")
      || !values.includes("insufficient_evidence"))
      return failure(context, "judge question requires explicit insufficient_evidence choice");
    const recipe = judgeRecipeSchema.safeParse(context.question.input_recipe);
    if (!recipe.success) return failure(context, "judge recipe is invalid");
    const references = recipe.data.judge.evidence_refs.map((ref) => context.evidence.references.find((item) => item.ref === ref));
    if (references.some((ref) => !ref) || recipe.data.judge.evidence_refs.some((ref) =>
      /(?:original|assessor).*(?:verdict|decision)|(?:verdict|decision).*(?:original|assessor)/i.test(ref)))
      return failure(context, "judge evidence selection is missing or includes a hidden verdict");
    const selected = references.map((reference) => ({ ref: reference!.ref, content: reference!.content }));
    const evidence = JSON.stringify(selected);
    if (evidence.length > recipe.data.judge.max_evidence_chars)
      return failure(context, "judge evidence exceeds its pinned bound");
    const prompt = { rubric: recipe.data.judge.rubric, target: recipe.data.judge.target,
      allowed_values: values, evidence,
      instruction: "Return JSON with choice, probabilities for every allowed value, confidence and optional explanation. Judge only the named target. Do not infer correctness from an explanation." };
    let response: Response;
    const started = Date.now();
    try { response = await (config.transport ?? fetch)(`${config.base_url.replace(/\/$/, "")}/chat/completions`, {
      method: "POST", signal: AbortSignal.timeout(config.deadline_ms ?? 30_000), headers: { Authorization: `Bearer ${config.api_key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: context.evaluator.model, temperature: 0, response_format: { type: "json_object" },
        messages: [{ role: "user", content: JSON.stringify(prompt) }] }),
    }); } catch { return failure(context, "judge transport failed"); }
    if (!response.ok) return failure(context, `judge HTTP ${response.status}`, response.headers.get("x-request-id"));
    let raw: unknown;
    try { raw = await response.json(); } catch { return failure(context, "judge response is not JSON"); }
    const completion = completionSchema.safeParse(raw);
    if (!completion.success) return failure(context, "judge completion does not match expected schema");
    let content: unknown;
    try { content = JSON.parse(completion.data.choices[0]!.message.content); }
    catch { return failure(context, "judge answer is not JSON"); }
    const answer = judgeAnswerSchema.safeParse(content);
    if (!answer.success || !values.includes(answer.data.choice)
      || values.some((value) => !(value in answer.data.probabilities)))
      return failure(context, "judge answer does not match question choices");
    const is_insufficient = answer.data.choice === "insufficient_evidence";
    const is_unclear = answer.data.choice === "unclear";
    return ok({ answer: is_insufficient || is_unclear
      ? { state: is_insufficient ? "abstain" : "unclear", kind: "choice", reason: answer.data.choice }
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
