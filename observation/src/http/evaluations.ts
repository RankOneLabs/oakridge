import type { Hono } from "hono";
import { z } from "zod";
import type { EvaluationIdentity } from "../grading/execution";
import type { GradingContext } from "../grading/runner";
import { deterministicChecker } from "../runners/deterministic-checker";
import { coverageChecker } from "../runners/coverage-checker";
import { stubModelRunner } from "../runners/stub-model";
import { registerGradingContext, runGrade } from "../storage/grading-store";
import type { SourceDependencies } from "./sources";
import { credentialFor } from "./ingest-auth";
import { errorResponse } from "./errors";

export const responseKindSchema = z.enum(["boolean", "choice", "ordinal", "numeric", "text", "structured"]);
export const contextSchema = z.object({
  question: z.object({ question_id: z.string().min(1), question_version: z.string().min(1),
    target_item_kinds: z.array(z.string().min(1)).min(1), input_recipe: z.record(z.string(), z.unknown()),
    response_kind: responseKindSchema, allowed_values: z.array(z.unknown()).nullable(),
    missing_evidence_policy: z.enum(["fail", "abstain"]), abstain_semantics: z.string(),
    unclear_semantics: z.string(), interpretation_caveats: z.string(), requires_repository_snapshot: z.boolean() }),
  evidence: z.object({ evidence_set_id: z.string().min(1),
    references: z.array(z.object({ ref: z.string().min(1),
      kind: z.enum(["raw_build_output", "raw_test_output", "repository_content", "public"]).optional(),
      content: z.unknown().nullable(), digest: z.string().nullable() })),
    is_incomplete: z.boolean(), incompleteness_reason: z.string().nullable() }),
  evaluator: z.object({ evaluator_definition_id: z.string().min(1), kind: z.enum(["model", "code", "human"]),
    backend_kind: z.string().min(1), provider: z.string().min(1), model: z.string().nullable(),
    prompt_digest: z.string(), config_digest: z.string(), runtime_revision: z.string().min(1),
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

export function registerEvaluationRoutes(app: Hono, deps: SourceDependencies): void {
  app.post("/v1/evaluations", async (c) => {
    const credential = credentialFor(c.req.header("authorization"), deps.credentials.grade ?? []);
    if (!credential) return errorResponse(c, 403, "forbidden", "grade credential required");
    let body: unknown;
    try { body = await c.req.json(); } catch { return errorResponse(c, 400, "invalid_json", "valid JSON body required"); }
    const parsed = z.object({ identity: identitySchema, context: contextSchema.optional(),
      runner: z.enum(["deterministic", "coverage", "stub_model"]) }).safeParse(body);
    if (!parsed.success) return errorResponse(c, 400, "invalid_evaluation", parsed.error.message);
    const identity = parsed.data.identity as EvaluationIdentity;
    if (parsed.data.context) {
      const context = parsed.data.context as unknown as GradingContext;
      if (!contextMatchesIdentity(context, identity)) return errorResponse(c, 400, "identity_mismatch", "context and identity differ");
      if (((parsed.data.runner === "deterministic" || parsed.data.runner === "coverage") && context.evaluator.kind !== "code")
        || (parsed.data.runner === "stub_model" && context.evaluator.kind !== "model"))
        return errorResponse(c, 400, "runner_mismatch", "runner does not match evaluator kind");
      const registered = await registerGradingContext(deps.db, credential, context);
      if (!registered.ok) return errorResponse(c, 422, "invalid_context", registered.error.detail);
    }
    const runner = parsed.data.runner === "deterministic" ? deterministicChecker
      : parsed.data.runner === "coverage" ? coverageChecker : stubModelRunner;
    const result = await runGrade(deps.db, credential, { identity, runner });
    return result.ok ? c.json(result.value, result.value.was_replay ? 200 : 201)
      : errorResponse(c, 422, "evaluation_refused", result.error.detail);
  });
}
