import { z } from "zod";
import type { V15OperatorRequestEnvelope } from "../domain/dev-flow-v15";
import type { CohortIngressError } from "../storage/apply-stage-event";
import type { Result } from "../domain/primitives";
import { Hono } from "hono";

import { parseUuidId, type CohortId } from "../domain/primitives";

export interface OperatorRetryHttpDependencies {
  readonly submit_request: (request: V15OperatorRequestEnvelope) => Promise<Result<{ readonly commits: number; readonly reason: string }, CohortIngressError>>;

}

// Mirrors the implementation OperatorRequest union; unknown fields are refused
// before any decision owner is loaded or mutated.
const artifactRef = z.object({ id: z.uuid(), version: z.number().int().positive() }).strict();
const buildTarget = z.object({ outputs: z.object({ build_result: artifactRef, pr_summary: artifactRef }).strict(),
  head_sha: z.string().min(1) }).strict();
const acceptedBuild = buildTarget.extend({ pr_url: z.string().url() }).strict();
const assessmentTarget = z.object({ assessment: artifactRef, build: acceptedBuild }).strict();
const artifactFeedback = z.object({ text: z.string().trim().min(1), target: artifactRef }).strict();
const briefCollection = z.object({ members: z.array(z.object({ cohort_key: z.string().min(1), ref: artifactRef }).strict()).min(1) }).strict();
const finalTarget = z.object({ pr_summary: artifactRef, pr_url: z.string().url(), head_sha: z.string().min(1) }).strict();
const operatorRequest = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("accept_analysis"), target: artifactRef }).strict(),
  z.object({ kind: z.literal("revise_analysis"), feedback: artifactFeedback }).strict(),
  z.object({ kind: z.literal("retry_analysis") }).strict(),
  z.object({ kind: z.literal("accept_plan"), target: artifactRef }).strict(),
  z.object({ kind: z.literal("revise_plan"), feedback: artifactFeedback }).strict(),
  z.object({ kind: z.literal("retry_plan") }).strict(),
  z.object({ kind: z.literal("accept_briefs"), target: briefCollection }).strict(),
  z.object({ kind: z.literal("revise_briefs"), feedback: z.object({ text: z.string().trim().min(1), target: briefCollection }).strict() }).strict(),
  z.object({ kind: z.literal("retry_briefs") }).strict(),
  z.object({ kind: z.literal("retry_provision") }).strict(),
  z.object({ kind: z.literal("retry_final_integration") }).strict(),
  z.object({ kind: z.literal("confirm_merged"), target: finalTarget }).strict(),
  z.object({ kind: z.literal("closed_without_merge"), target: finalTarget }).strict(),
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

/** Versioned, targeted worker requests enter the authoritative cohort owner. */
export const createOperatorRetryApp = (dependencies: OperatorRetryHttpDependencies): Hono => {
  const app = new Hono();
  app.post("/cohorts/:cohortId/requests", async (http) => {
    const cohort_id = parseUuidId<CohortId>(http.req.param("cohortId"));
    if (!cohort_id) return http.json({ error: "invalid cohort id" }, 400);
    const parsed = requestEnvelope.safeParse(await http.req.json().catch(() => null));
    if (!parsed.success) return http.json({ error: parsed.error.message }, 422);
    if (!dependencies.submit_request) return http.json({ error: "cohort request ingress is unavailable" }, 503);
    const request = { ...parsed.data, cohort_id } as V15OperatorRequestEnvelope;
    const result = await dependencies.submit_request(request);
    if (!result.ok) return http.json({ error: result.error }, result.error.kind === "cohort_not_found" ? 404 : 409);
    return http.json(result.value, 202);
  });
  return app;
};
