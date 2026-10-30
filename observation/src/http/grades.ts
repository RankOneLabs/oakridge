import type { Hono } from "hono";
import { z } from "zod";
import type { BlindAssignmentId } from "../domain/identity";
import type { EvaluationIdentity } from "../grading/execution";
import type { GradeAnswer } from "../grading/observation";
import type { GradingContext } from "../grading/runner";
import { isLangfuseAnnotationEvaluator, NATIVE_HUMAN_EVALUATOR } from "../grading/evaluator";
import { blindEvidence, blindReferenceAddresses } from "../langfuse/blinding";
import { PILOT_EVIDENCE_RECIPES, type EvidenceRole } from "../langfuse/evidence-recipe";
import { acceptHumanGrade } from "../runners/human-intake";
import { ensureNativeHumanEvaluator, listGrades, readEvidenceSet, readQuestionDefinition,
  registerGradingContext, type GradeDetails } from "../storage/grading-store";
import type { SourceDependencies } from "./sources";
import { contextMatchesIdentity, contextSchema, identitySchema, responseKindSchema } from "./evaluations";
import { boundReviewer, credentialFor } from "./ingest-auth";
import { errorResponse } from "./errors";
import { claimBlindAssignment, createBlindAssignment, listUnclaimedBlindAssignments, readBlindAssignment,
  type BlindAssignmentIdentity } from "../storage/blind-assignment-store";

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
  reviewer_id: z.string().min(1).optional(), reviewer_details: z.unknown().nullable().default(null),
  collection_mode: z.enum(["blind", "in_context"]), blind_assignment_id: z.string().min(1).nullable().default(null),
  model_answers_visible: z.boolean(), workflow_decisions_visible: z.boolean(),
  comments: z.string().nullable().default(null), rationale: z.string().nullable().default(null),
  quality_flags: z.array(z.string()).default([]), supersedes_observation_id: z.string().nullable().default(null) });

export function registerGradeRoutes(app: Hono, deps: SourceDependencies): void {
  app.get("/v1/blind-assignments", async (c) => {
    const credential = credentialFor(c.req.header("authorization"), deps.credentials.grade ?? []);
    if (!credential) return errorResponse(c, 403, "forbidden", "grade credential required");
    const limit = Number(new URL(c.req.url).searchParams.get("limit") ?? "50");
    if (!Number.isInteger(limit) || limit < 1 || limit > 50)
      return errorResponse(c, 400, "invalid_pagination", "limit must be 1..50");
    return c.json({ items: await listUnclaimedBlindAssignments(deps.db, credential, limit) });
  });
  app.post("/v1/blind-assignments", async (c) => {
    const credential = credentialFor(c.req.header("authorization"), deps.credentials.grade ?? []);
    if (!credential) return errorResponse(c, 403, "forbidden", "grade credential required");
    let body: unknown;
    try { body = await c.req.json(); } catch { return errorResponse(c, 400, "invalid_json", "valid JSON body required"); }
    const parsed = z.object({ subject_occurrence_id: z.string().min(1), evidence_set_id: z.string().min(1),
      question_id: z.string().min(1), question_version: z.string().min(1) }).safeParse(body);
    if (!parsed.success) return errorResponse(c, 400, "invalid_assignment", parsed.error.message);
    const result = await createBlindAssignment(deps.db, credential, parsed.data as BlindAssignmentIdentity);
    return result.ok ? c.json(result.value, 201) : errorResponse(c, 409, "assignment_refused", result.error.detail);
  });
  app.post("/v1/blind-assignments/:id/claim", async (c) => {
    const credential = credentialFor(c.req.header("authorization"), deps.credentials.grade ?? []);
    if (!credential) return errorResponse(c, 403, "forbidden", "grade credential required");
    const result = await claimBlindAssignment(deps.db, credential, {
      assignment_id: c.req.param("id") as BlindAssignmentId, reviewer_id: boundReviewer(credential), duration_seconds: 900 });
    return result.ok ? c.json(result.value) : errorResponse(c, 409, "claim_refused", result.error.detail);
  });
  app.get("/v1/blind-assignments/:id", async (c) => {
    const credential = credentialFor(c.req.header("authorization"), deps.credentials.grade ?? []);
    if (!credential) return errorResponse(c, 403, "forbidden", "grade credential required");
    const assignment = await readBlindAssignment(deps.db, credential,
      c.req.param("id") as BlindAssignmentId, boundReviewer(credential));
    if (!assignment) return errorResponse(c, 404, "not_found", "assignment not found");
    const [question, evidence] = await Promise.all([
      readQuestionDefinition(deps.db, credential, assignment.question_id, assignment.question_version),
      readEvidenceSet(deps.db, credential, assignment.evidence_set_id),
    ]);
    if (!question || !evidence) return errorResponse(c, 404, "not_found", "pinned grading context not found");
    const addresses = blindReferenceAddresses(evidence.references);
    if (!addresses.ok) return errorResponse(c, 422, "blind_evidence_refused", addresses.error.detail);
    const isPilot = Object.hasOwn(PILOT_EVIDENCE_RECIPES, question.question_id);
    if (isPilot && addresses.value.some((address) => !address.digest || !address.deep_link))
      return errorResponse(c, 422, "blind_evidence_refused", "pinned evidence address lacks digest or deep link");
    const sources = addresses.value.map((address) => ({ ref: address.ref,
      digest: address.digest!, deep_link: address.deep_link!,
      role: address.ref.split(":", 1)[0] as EvidenceRole }));
    const blinded = isPilot ? blindEvidence(question, sources, "report") : null;
    if (blinded && !blinded.ok) return errorResponse(c, 422, "blind_evidence_refused", blinded.error.detail);
    return c.json({ ...assignment, blinded_evidence: blinded?.ok ? blinded.value : { references: addresses.value } });
  });
  app.post("/v1/grades", async (c) => {
    const credential = credentialFor(c.req.header("authorization"), deps.credentials.grade ?? []);
    if (!credential) return errorResponse(c, 403, "forbidden", "grade credential required");
    let body: unknown;
    try { body = await c.req.json(); } catch { return errorResponse(c, 400, "invalid_json", "valid JSON body required"); }
    const parsed = z.object({ identity: identitySchema, context: contextSchema.optional(), details: detailsSchema }).safeParse(body);
    if (!parsed.success) return errorResponse(c, 400, "invalid_grade", parsed.error.message);
    const reviewer_id = boundReviewer(credential);
    if (parsed.data.details.reviewer_id && parsed.data.details.reviewer_id !== reviewer_id)
      return errorResponse(c, 403, "reviewer_mismatch", "reviewer id differs from grade credential");
    if (parsed.data.details.collection_mode === "blind" &&
      (parsed.data.details.model_answers_visible || parsed.data.details.workflow_decisions_visible || !parsed.data.details.blind_assignment_id))
      return errorResponse(c, 400, "invalid_blind_grade", "blind submission requires a hidden assignment");
    const identity = parsed.data.identity as EvaluationIdentity;
    if (identity.evaluator_definition_id === "oakridge-operator-human"
      || isLangfuseAnnotationEvaluator(identity.evaluator_definition_id))
      return errorResponse(c, 400, "reserved_evaluator", "evaluator is reserved for its authenticated import path");
    if (parsed.data.context) {
      const context = parsed.data.context as unknown as GradingContext;
      if (!contextMatchesIdentity(context, identity)) return errorResponse(c, 400, "identity_mismatch", "context and identity differ");
      if (context.evaluator.kind !== "human") return errorResponse(c, 400, "invalid_evaluator", "human evaluator required");
      const registered = await registerGradingContext(deps.db, credential, context);
      if (!registered.ok) return errorResponse(c, 422, "invalid_context", registered.error.detail);
    }
    if (identity.evaluator_definition_id === NATIVE_HUMAN_EVALUATOR.evaluator_definition_id) {
      const registered = await ensureNativeHumanEvaluator(deps.db, credential);
      if (!registered.ok) return errorResponse(c, 422, "invalid_evaluator", registered.error.detail);
    }
    const result = await acceptHumanGrade(deps.db, credential, { ...identity,
      details: { ...parsed.data.details, reviewer_id, answer: parsed.data.details.answer as GradeAnswer } as GradeDetails });
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
