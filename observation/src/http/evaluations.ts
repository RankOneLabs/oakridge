import type { Hono } from "hono";
import { z } from "zod";
import type { EvaluationIdentity } from "../grading/execution";
import type { GradingContext } from "../grading/runner";
import { deterministicChecker } from "../runners/deterministic-checker";
import { coverageChecker } from "../runners/coverage-checker";
import { stubModelRunner } from "../runners/stub-model";
import { jevDirectRunner } from "../runners/jev-direct";
import { fastinoGlideRunner } from "../runners/fastino-glide";
import { llmJudgeRunner } from "../runners/llm-judge";
import { ingestModelScore } from "../langfuse/score-ingestion";
import { createLangfuseHttpClient } from "../langfuse/http-client";
import type { GradeAnswer } from "../grading/observation";
import { registerGradingContext, runGrade } from "../storage/grading-store";
import { withTenant } from "../storage/database";
import type { LangfuseRouteDependencies } from "./langfuse-sync";
import { credentialFor } from "./ingest-auth";
import { errorResponse } from "./errors";

export const responseKindSchema = z.enum(["boolean", "choice", "ordinal", "numeric", "text", "structured"]);
export const contextSchema = z.object({
  question: z.object({ question_id: z.string().min(1), question_version: z.string().min(1),
    question_text: z.string().optional(), evidence_recipe_provenance: z.object({ recipe_id: z.string(), recipe_version: z.string(), source: z.string() }).optional(),
    target_item_kinds: z.array(z.string().min(1)).min(1), input_recipe: z.record(z.string(), z.unknown()),
    response_kind: responseKindSchema, allowed_values: z.array(z.unknown()).nullable(),
    missing_evidence_policy: z.enum(["fail", "abstain"]), abstain_semantics: z.string(),
    unclear_semantics: z.string(), interpretation_caveats: z.string(), requires_repository_snapshot: z.boolean() }),
  evidence: z.object({ evidence_set_id: z.string().min(1),
    references: z.array(z.object({ ref: z.string().min(1),
      kind: z.enum(["raw_build_output", "raw_test_output", "repository_content", "public", "internal"]),
      content: z.unknown().nullable(), digest: z.string().nullable(), deep_link: z.string().optional(),
      reviewed_commit: z.string().optional(), is_truncated: z.boolean().optional(),
      is_unreadable: z.boolean().optional(), incompleteness_reason: z.string().optional() })),
    is_incomplete: z.boolean(), incompleteness_reason: z.string().nullable() }),
  evaluator: z.object({ evaluator_definition_id: z.string().min(1), kind: z.enum(["model", "code", "human"]),
    backend_kind: z.string().min(1), provider: z.string().min(1), model: z.string().nullable(),
    prompt_digest: z.string(), instruction_text: z.string(), config_digest: z.string(), runtime_revision: z.string().min(1),
    cost_metadata: z.unknown().nullable(), seed: z.number().int().nullable(), attempt_controls: z.unknown().nullable() }),
});
export const identitySchema = z.object({ subject_occurrence_id: z.string().min(1), evidence_set_id: z.string().min(1),
  question_id: z.string().min(1), question_version: z.string().min(1), evaluator_definition_id: z.string().min(1),
  config_digest: z.string(), attempt_label: z.string().min(1) });

export function contextMatchesIdentity(context: GradingContext, identity: EvaluationIdentity): boolean {
  return context.question.question_id === identity.question_id && context.question.question_version === identity.question_version
    && context.evidence.evidence_set_id === identity.evidence_set_id
    && context.evaluator.evaluator_definition_id === identity.evaluator_definition_id
    && context.evaluator.config_digest === identity.config_digest;
}

const modelRunners = { stub_model: stubModelRunner, jev_direct: jevDirectRunner,
  fastino_glide: fastinoGlideRunner, llm_judge: llmJudgeRunner } as const;

export function registerEvaluationRoutes(app: Hono, deps: LangfuseRouteDependencies): void {
  app.post("/v1/evaluations", async (c) => {
    const credential = credentialFor(c.req.header("authorization"), deps.credentials.grade ?? []);
    if (!credential) return errorResponse(c, 403, "forbidden", "grade credential required");
    let body: unknown;
    try { body = await c.req.json(); } catch { return errorResponse(c, 400, "invalid_json", "valid JSON body required"); }
    const parsed = z.object({ identity: identitySchema, context: contextSchema.optional(),
      runner: z.enum(["deterministic", "coverage", "stub_model", "jev_direct", "fastino_glide", "llm_judge"]) }).safeParse(body);
    if (!parsed.success) return errorResponse(c, 400, "invalid_evaluation", parsed.error.message);
    const identity = parsed.data.identity as EvaluationIdentity;
    if (parsed.data.context) {
      const context = parsed.data.context as unknown as GradingContext;
      if (!contextMatchesIdentity(context, identity)) return errorResponse(c, 400, "identity_mismatch", "context and identity differ");
      if (((parsed.data.runner === "deterministic" || parsed.data.runner === "coverage") && context.evaluator.kind !== "code")
        || (parsed.data.runner in modelRunners && context.evaluator.kind !== "model"))
        return errorResponse(c, 400, "runner_mismatch", "runner does not match evaluator kind");
      const registered = await registerGradingContext(deps.db, credential, context);
      if (!registered.ok) return errorResponse(c, 422, "invalid_context", registered.error.detail);
    }
    const runner = parsed.data.runner === "deterministic" ? deterministicChecker
      : parsed.data.runner === "coverage" ? coverageChecker : modelRunners[parsed.data.runner];
    const result = await runGrade(deps.db, credential, { identity, runner });
    return result.ok ? c.json(result.value, result.value.was_replay ? 200 : 201)
      : errorResponse(c, 422, "evaluation_refused", result.error.detail);
  });
  app.post("/v1/langfuse/model-scores", async (c) => {
    const tenant = credentialFor(c.req.header("authorization"), deps.credentials.grade ?? []);
    if (!tenant) return errorResponse(c, 403, "forbidden", "grade credential required");
    if (!deps.langfuse || deps.langfuse.status === "disabled")
      return errorResponse(c, 422, "langfuse_disabled", "Langfuse is disabled");
    const parsed = z.object({ execution_id: z.string().min(1) }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return errorResponse(c, 400, "invalid_score_request", "execution_id required");
    const source = await withTenant(deps.db, tenant, async (trx) => {
      const execution = await trx.selectFrom("observation.evaluation_execution").selectAll()
        .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
        .where("execution_id", "=", parsed.data.execution_id).executeTakeFirst();
      if (!execution || execution.status !== "completed") return null;
      const observation = await trx.selectFrom("observation.grade_observation").selectAll()
        .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
        .where("execution_id", "=", execution.execution_id).executeTakeFirst();
      const mapping = await trx.selectFrom("observation.langfuse_mapping").selectAll()
        .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
        .where("execution_id", "=", execution.execution_id).where("trace_id", "is not", null)
        .executeTakeFirst();
      const evaluator = await trx.selectFrom("observation.evaluator_definition").selectAll()
        .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
        .where("evaluator_definition_id", "=", execution.evaluator_definition_id).executeTakeFirst();
      return observation && mapping?.trace_id && mapping.observation_id && evaluator?.model
        && evaluator.kind === "model" ? { execution, observation, mapping, evaluator } : null;
    });
    if (!source) return errorResponse(c, 409, "projection_pending", "completed model grade and mapped Langfuse observation required");
    const client = createLangfuseHttpClient(deps.langfuse.config);
    const result = await ingestModelScore(client, { score_id: source.observation.observation_id,
      trace_id: source.mapping.trace_id!, external_observation_id: source.mapping.observation_id!,
      question_id: source.execution.question_id, question_version: source.execution.question_version,
      evaluator_definition_id: source.execution.evaluator_definition_id,
      provider: source.evaluator.provider, model: source.evaluator.model!,
      answer: source.observation.answer_payload as GradeAnswer,
      probabilities: source.observation.probabilities as Record<string, number> | null,
      confidence: source.observation.confidence });
    return result.ok ? c.json({ score_id: result.value }, 200)
      : errorResponse(c, 422, "score_ingestion_failed", result.error.detail);
  });
}
