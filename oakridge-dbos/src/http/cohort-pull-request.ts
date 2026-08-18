/**
 * One way in for evidence that a cohort's pull request merged.
 *
 * The poller posts what GitHub reported; an operator posts a confirmation when
 * the poller cannot see the repository. Both land on the same route and are
 * checked against the same expectations — the manual path is a fallback for
 * missing *visibility*, not a way around the checks.
 */
import { Hono } from "hono";

import type { StageInstanceId, UnitId } from "../domain/primitives";
import type { ObservedPullRequestState, PullRequestObservation, PullRequestObservationSource } from "../domain/pull-request";
import { reconcileCohortEvidence, type CohortPullRequestDependencies, type CohortPullRequestEvidence } from "../runtime/cohort-pull-request";

export type CohortPullRequestHttpDependencies = CohortPullRequestDependencies;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const trimmed = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);

const OBSERVED_STATES: readonly ObservedPullRequestState[] = ["open", "merged", "closed_unmerged"];
const OBSERVATION_SOURCES: readonly PullRequestObservationSource[] = ["poll", "webhook", "manual_recheck"];

const parseObservation = (value: unknown): PullRequestObservation | null => {
  if (!isObject(value)) return null;
  const owner = trimmed(value.owner);
  const name = trimmed(value.name);
  const url = trimmed(value.url);
  const headBranch = trimmed(value.head_branch);
  const baseBranch = typeof value.base_branch === "string" ? value.base_branch : null;
  const observedAt = trimmed(value.observed_at);
  const state = OBSERVED_STATES.find((candidate) => candidate === value.state);
  const source = OBSERVATION_SOURCES.find((candidate) => candidate === value.source);
  if (value.provider !== "github" || !owner || !name || !url || !headBranch || baseBranch === null || !observedAt || !state || !source) return null;
  if (typeof value.number !== "number" || !Number.isInteger(value.number) || value.number <= 0) return null;
  if (Number.isNaN(Date.parse(observedAt))) return null;
  const mergedAt = value.merged_at === null || value.merged_at === undefined ? null : trimmed(value.merged_at);
  if (mergedAt !== null && Number.isNaN(Date.parse(mergedAt))) return null;
  return {
    provider: "github", owner, name, number: value.number, url, head_branch: headBranch, base_branch: baseBranch,
    head_sha: typeof value.head_sha === "string" ? value.head_sha : null,
    state, source, observed_at: observedAt, merged_at: mergedAt,
  };
};

const parseEvidence = (value: unknown): CohortPullRequestEvidence | null => {
  if (!isObject(value)) return null;
  if (value.kind === "observation") {
    const observation = parseObservation(value.observation);
    return observation ? { kind: "observation", observation } : null;
  }
  if (value.kind === "operator_confirmation") {
    const idempotencyKey = trimmed(value.idempotency_key);
    const comment = trimmed(value.operator_comment);
    return idempotencyKey && comment ? { kind: "operator_confirmation", idempotency_key: idempotencyKey, operator_comment: comment } : null;
  }
  return null;
};

export const createCohortPullRequestApp = (dependencies: CohortPullRequestHttpDependencies): Hono => {
  const app = new Hono();
  app.post("/cohorts/:cohortId/pull_request", async (http) => {
    // Addressed the way a gate is: `{stage_instance_id}:{unit_id}`, which is
    // the id the operator projections already hand out for a cohort.
    const compositeId = http.req.param("cohortId");
    const separator = compositeId.indexOf(":");
    if (separator < 1 || separator === compositeId.length - 1) return http.json({ error: "invalid cohort id: expected '{stage_instance_id}:{unit_id}'" }, 400);
    const stageInstanceId = compositeId.slice(0, separator) as StageInstanceId;
    const unitId = compositeId.slice(separator + 1) as UnitId;

    let raw: unknown;
    try { raw = await http.req.json(); } catch { return http.json({ error: "request body must be JSON" }, 400); }
    const evidence = parseEvidence(raw);
    if (!evidence) {
      return http.json({ error: "body must be {kind:'observation', observation} or {kind:'operator_confirmation', idempotency_key, operator_comment}" }, 400);
    }

    const result = await reconcileCohortEvidence(dependencies, stageInstanceId, unitId, evidence);
    if (!result.ok) {
      const status = result.error.kind === "cohort_not_found" ? 404 : result.error.kind === "mismatch" ? 409 : 409;
      return http.json({ error: result.error.detail, code: result.error.kind, ...(result.error.reconciliation ? { reconciliation: result.error.reconciliation } : {}) }, status);
    }
    return http.json({ cohort_id: compositeId, outcome: result.value.resolution, reconciliation: result.value.reconciliation }, 202);
  });
  return app;
};
