import type { Hono } from "hono";
import { z } from "zod";
import type { EvaluationIdentity } from "../grading/execution";
import type { GradeAnswer } from "../grading/observation";
import type { GradingContext } from "../grading/runner";
import { acceptHumanGrade } from "../runners/human-intake";
import { listGrades, registerGradingContext, type GradeDetails } from "../storage/grading-store";
import type { SourceDependencies } from "./sources";
import { contextMatchesIdentity, contextSchema, identitySchema, responseKindSchema } from "./evaluations";
import { credentialFor } from "./ingest-auth";
import { errorResponse } from "./errors";

const answerSchema = z.union([
  z.object({ state: z.literal("answered"), kind: z.literal("boolean"), value: z.boolean() }),
  z.object({ state: z.literal("answered"), kind: z.literal("choice"), value: z.string() }),
  z.object({ state: z.literal("answered"), kind: z.literal("ordinal"), value: z.string() }),
  z.object({ state: z.literal("answered"), kind: z.literal("numeric"), value: z.number().finite() }),
  z.object({ state: z.literal("answered"), kind: z.literal("text"), value: z.string() }),
  z.object({ state: z.literal("answered"), kind: z.literal("structured"), value: z.unknown() }),
  z.object({ state: z.enum(["abstain", "unclear"]), kind: responseKindSchema, reason: z.string().min(1) }),
]);
const detailsSchema = z.object({ answer: answerSchema, probabilities: z.record(z.string(), z.number().min(0).max(1)).nullable().default(null),
  confidence: z.number().min(0).max(1).nullable().default(null), normalized_score: z.number().finite().nullable().default(null),
  decision_policy_id: z.string().nullable().default(null), decision_policy_version: z.string().nullable().default(null),
  reviewer_id: z.string().min(1), reviewer_details: z.unknown().nullable().default(null),
  comments: z.string().nullable().default(null), rationale: z.string().nullable().default(null),
  quality_flags: z.array(z.string()).default([]), supersedes_observation_id: z.string().nullable().default(null) });

export function registerGradeRoutes(app: Hono, deps: SourceDependencies): void {
  app.post("/v1/grades", async (c) => {
    const credential = credentialFor(c.req.header("authorization"), deps.credentials.grade ?? []);
    if (!credential) return errorResponse(c, 403, "forbidden", "grade credential required");
    let body: unknown;
    try { body = await c.req.json(); } catch { return errorResponse(c, 400, "invalid_json", "valid JSON body required"); }
    const parsed = z.object({ identity: identitySchema, context: contextSchema.optional(), details: detailsSchema }).safeParse(body);
    if (!parsed.success) return errorResponse(c, 400, "invalid_grade", parsed.error.message);
    const identity = parsed.data.identity as EvaluationIdentity;
    if (parsed.data.context) {
      const context = parsed.data.context as unknown as GradingContext;
      if (!contextMatchesIdentity(context, identity)) return errorResponse(c, 400, "identity_mismatch", "context and identity differ");
      if (context.evaluator.kind !== "human") return errorResponse(c, 400, "invalid_evaluator", "human evaluator required");
      const registered = await registerGradingContext(deps.db, credential, context);
      if (!registered.ok) return errorResponse(c, 422, "invalid_context", registered.error.detail);
    }
    const result = await acceptHumanGrade(deps.db, credential, { ...identity,
      details: { ...parsed.data.details, answer: parsed.data.details.answer as GradeAnswer } as GradeDetails });
    return result.ok ? c.json(result.value, result.value.was_replay ? 200 : 201)
      : errorResponse(c, 422, "grade_refused", result.error.detail);
  });
  app.get("/v1/items/:id/grades", async (c) => {
    const credential = credentialFor(c.req.header("authorization"), deps.credentials.read);
    if (!credential) return errorResponse(c, 403, "forbidden", "read credential required");
    const params = new URL(c.req.url).searchParams;
    const limit = Number(params.get("limit") ?? "50"); const offset = Number(params.get("offset") ?? "0");
    if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0)
      return errorResponse(c, 400, "invalid_pagination", "limit must be 1..200 and offset nonnegative");
    const page = await listGrades(deps.db, credential, c.req.param("id"), { limit, offset });
    return page ? c.json(page) : errorResponse(c, 404, "not_found", "item not found");
  });
}
