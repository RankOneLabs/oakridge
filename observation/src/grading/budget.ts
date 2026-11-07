import { err, ok, type Result } from "../domain/primitives";

/**
 * The operational controls of automatic grading, read once at startup. The run allowance is the
 * only spend cap: there is no stage cap and no concurrency cap, and it is counted in configured
 * estimates, never in what a provider later reports.
 */
export interface GradingControls {
  /** `OBSERVATION_GRADING_RUN_SPEND`: the estimated spend one run may reserve across every stage,
   * question, evaluator and retry. */
  readonly run_spend: number;
  /** `OBSERVATION_GRADING_RETRY_LIMIT`: retries persisted on each execution at admission. */
  readonly retry_limit: number;
  /** `OBSERVATION_PROVIDER_DEADLINE_MS`: how long one provider request may run. */
  readonly provider_deadline_ms: number;
  /** `OBSERVATION_GRADING_LEASE_MS`: how long a claim stays current; it outlasts the request. */
  readonly lease_ms: number;
}

export const DEFAULT_RUN_SPEND = 5;
const DEFAULT_RETRY_LIMIT = 3;
const DEFAULT_PROVIDER_DEADLINE_MS = 30_000;
/** A lease outlasts the provider deadline by this much, so a request in time never loses its claim. */
const LEASE_MARGIN_MS = 15_000;
const MINIMUM_LEASE_MS = 45_000;

export interface GradingControlError { readonly operation: "grading_controls"; readonly entity_id: string; readonly detail: string }
const failure = (entity_id: string, detail: string): Result<never, GradingControlError> =>
  err({ operation: "grading_controls", entity_id, detail });

function setting(env: NodeJS.ProcessEnv, name: string, fallback: number, is_integer: boolean): Result<number, GradingControlError> {
  const raw = env[name];
  if (raw === undefined) return ok(fallback);
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(value) || value < 0 || (is_integer && !Number.isInteger(value)))
    return failure(name, `must be a finite nonnegative ${is_integer ? "integer" : "number"}`);
  return ok(value);
}

export function gradingControls(env: NodeJS.ProcessEnv): Result<GradingControls, GradingControlError> {
  const run_spend = setting(env, "OBSERVATION_GRADING_RUN_SPEND", DEFAULT_RUN_SPEND, false);
  if (!run_spend.ok) return run_spend;
  const retry_limit = setting(env, "OBSERVATION_GRADING_RETRY_LIMIT", DEFAULT_RETRY_LIMIT, true);
  if (!retry_limit.ok) return retry_limit;
  const provider_deadline_ms = setting(env, "OBSERVATION_PROVIDER_DEADLINE_MS", DEFAULT_PROVIDER_DEADLINE_MS, true);
  if (!provider_deadline_ms.ok) return provider_deadline_ms;
  const required_lease_ms = provider_deadline_ms.value + LEASE_MARGIN_MS;
  const lease_ms = setting(env, "OBSERVATION_GRADING_LEASE_MS", Math.max(MINIMUM_LEASE_MS, required_lease_ms), true);
  if (!lease_ms.ok) return lease_ms;
  if (lease_ms.value < required_lease_ms)
    return failure("OBSERVATION_GRADING_LEASE_MS", `must exceed OBSERVATION_PROVIDER_DEADLINE_MS by ${LEASE_MARGIN_MS} ms`);
  return ok({ run_spend: run_spend.value, retry_limit: retry_limit.value, provider_deadline_ms: provider_deadline_ms.value,
    lease_ms: lease_ms.value });
}

/** Whether the next estimated request fits what the run has already sent or reserved. */
export function fitsRunAllowance(input: { readonly committed: number; readonly estimate: number; readonly allowance: number }): boolean {
  return input.committed + input.estimate <= input.allowance + Number.EPSILON;
}

/** The configured estimate a pinned evaluator definition carries, or null when it carries none. */
export function estimatedCostPerCall(cost_metadata: unknown): number | null {
  if (cost_metadata === null || typeof cost_metadata !== "object" || Array.isArray(cost_metadata)) return null;
  const value = (cost_metadata as { readonly estimated_cost_per_call?: unknown }).estimated_cost_per_call;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
