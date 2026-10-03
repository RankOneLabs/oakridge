import { z } from "zod";
import type { OperatorRequestEnvelope } from "../domain/dev-flow-v15";
import type { CohortIngressError } from "../storage/apply-stage-event";
import type { Result } from "../domain/primitives";
import { Hono, type Context } from "hono";

import { parseUuidId, type CohortId, type StageInstanceId } from "../domain/primitives";
import type { RetryCohortResult, RetryCohortTarget } from "../domain/run-record";

export interface OperatorRetryHttpDependencies {
  submit_request?(request: OperatorRequestEnvelope): Promise<Result<{ readonly commits: number; readonly reason: string }, CohortIngressError>>;
  retry_through_driver(target: RetryCohortTarget, idempotency_key: string): Promise<RetryCohortResult>;
  abandon?(cohort_id: CohortId, detail: string): Promise<{ readonly kind: "applied"; readonly state: string }
    | { readonly kind: "refused"; readonly code: string; readonly detail: string }
    | { readonly kind: "not_found" }>;
}

// Mirrors the implementation OperatorRequest union; unknown fields are refused
// before any decision owner is loaded or mutated.
const artifactRef = z.object({ id: z.uuid(), version: z.number().int().positive() }).strict();
const buildTarget = z.object({ outputs: z.object({ build_result: artifactRef, pr_summary: artifactRef }).strict(),
  head_sha: z.string().min(1) }).strict();
const acceptedBuild = buildTarget.extend({ pr_url: z.string().url() }).strict();
const assessmentTarget = z.object({ assessment: artifactRef, build: acceptedBuild }).strict();
const operatorRequest = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("accept_build"), target: buildTarget }).strict(),
  z.object({ kind: z.literal("replace_pr"), target: buildTarget }).strict(),
  z.object({ kind: z.literal("accept_assessment"), target: assessmentTarget }).strict(),
  z.object({ kind: z.literal("request_build_changes"), feedback: z.object({
    source: z.literal("build_review"), text: z.string().trim().min(1), target: buildTarget }).strict() }).strict(),
  z.object({ kind: z.literal("request_implementation_changes"), feedback: z.object({
    source: z.literal("assessment"), text: z.string().trim().min(1), target: assessmentTarget }).strict() }).strict(),
  z.object({ kind: z.literal("discuss_assessment"), feedback: z.object({
    text: z.string().trim().min(1), target: assessmentTarget }).strict() }).strict(),
  z.object({ kind: z.literal("retry_build") }).strict(),
  z.object({ kind: z.literal("retry_assessment") }).strict(),
  z.object({ kind: z.literal("cancel") }).strict(),
  z.object({ kind: z.literal("abandon"), reason: z.string().trim().min(1) }).strict(),
]);
const requestEnvelope = z.object({ id: z.uuid(), expected_version: z.number().int().nonnegative(),
  request: operatorRequest }).strict();

/**
 * Operator retry of a cohort, addressed either by the cohort row id or by the
 * stage instance + cohort key kbbl's run detail already holds. Both forms
 * enter the cohort driver; the route only decides how the cohort is named.
 *
 * The path segments keep their `run-units` / `units` spelling: v15's cohort is
 * what v14 called a run unit, and the PWA addresses it by the same two ids.
 */
export const createOperatorRetryApp = (dependencies: OperatorRetryHttpDependencies): Hono => {
  const app = new Hono();
  app.post("/cohorts/:cohortId/requests", async (http) => {
    const cohort_id = parseUuidId<CohortId>(http.req.param("cohortId"));
    if (!cohort_id) return http.json({ error: "invalid cohort id" }, 400);
    const parsed = requestEnvelope.safeParse(await http.req.json().catch(() => null));
    if (!parsed.success) return http.json({ error: parsed.error.message }, 422);
    if (!dependencies.submit_request) return http.json({ error: "cohort request ingress is unavailable" }, 503);
    const request = { ...parsed.data, cohort_id } as OperatorRequestEnvelope;
    const result = await dependencies.submit_request(request);
    if (!result.ok) return http.json({ error: result.error }, result.error.kind === "cohort_not_found" ? 404 : 409);
    return http.json(result.value, 202);
  });
  const retry = async (http: Context, target: RetryCohortTarget) => {
    const idempotencyKey = http.req.header("idempotency-key")?.trim();
    if (!idempotencyKey) return http.json({ error: "Idempotency-Key header is required" }, 400);
    const result = await dependencies.retry_through_driver(target, idempotencyKey);
    if (result.kind === "cohort_not_found") return http.json({ error: result.detail }, 404);
    if (result.kind === "not_retryable") return http.json({ kind: result.kind, reason: result.reason }, 409);
    if (result.kind === "idempotency_conflict") return http.json({ error: result.detail, kind: result.kind }, 409);
    if (result.kind === "refused") return http.json({ code: result.code, detail: result.detail }, 409);
    return http.json({ run_id: result.run_id, cohort_id: result.cohort_id, attempt_id: result.attempt_id,
      attempt_number: result.attempt_number, record_version: result.durable_version },
    result.kind === "created" ? 202 : 200);
  };
  app.put("/run-units/:runUnitId/retry", async (http) => {
    const cohortId = parseUuidId<CohortId>(http.req.param("runUnitId"));
    if (!cohortId) return http.json({ error: "invalid cohort id" }, 400);
    return retry(http, { kind: "cohort", cohort_id: cohortId });
  });
  app.put("/stage_instances/:stageInstanceId/units/:unitId/retry", async (http) => {
    const stageInstanceId = parseUuidId<StageInstanceId>(http.req.param("stageInstanceId"));
    if (!stageInstanceId) return http.json({ error: "invalid stage instance id" }, 400);
    const cohortKey = http.req.param("unitId");
    if (!cohortKey) return http.json({ error: "unit id is required" }, 400);
    return retry(http, { kind: "stage_cohort", stage_instance_id: stageInstanceId, cohort_key: cohortKey });
  });
  app.post("/cohorts/:cohortId/abandon", async (http) => {
    const cohort_id = parseUuidId<CohortId>(http.req.param("cohortId"));
    if (!cohort_id) return http.json({ error: "invalid cohort id" }, 400);
    const body: unknown = await http.req.json().catch(() => null);
    if (typeof body !== "object" || body === null || Array.isArray(body)
      || typeof (body as { readonly detail?: unknown }).detail !== "string"
      || !(body as { readonly detail: string }).detail.trim()) return http.json({ error: "detail is required" }, 422);
    if (!dependencies.abandon) return http.json({ error: "abandon is unavailable" }, 503);
    const outcome = await dependencies.abandon(cohort_id, (body as { readonly detail: string }).detail.trim());
    if (outcome.kind === "not_found") return http.json({ error: "cohort not found" }, 404);
    if (outcome.kind === "refused") return http.json({ code: outcome.code, detail: outcome.detail }, 409);
    return http.json({ state: outcome.state }, 202);
  });
  return app;
};
