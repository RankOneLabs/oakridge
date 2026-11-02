/** Caps are intentionally small until a provider is explicitly enabled. */
export interface GradingLimits {
  readonly lease_ms: number;
  readonly retry_limit: number;
  readonly run_concurrency: number;
  readonly stage_concurrency: number;
  readonly run_spend: number;
  readonly stage_spend: number;
  readonly provider_deadline_ms: number;
}
function limit(env: NodeJS.ProcessEnv, name: string, fallback: number, integer = false): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value)))
    throw new Error(`${name} must be a finite nonnegative ${integer ? "integer" : "number"}`);
  return value;
}
export function gradingLimits(env: NodeJS.ProcessEnv = process.env): GradingLimits {
  const provider_deadline_ms = limit(env, "OBSERVATION_PROVIDER_DEADLINE_MS", 30_000);
  return { provider_deadline_ms, lease_ms: limit(env, "OBSERVATION_GRADING_LEASE_MS", 45_000),
    retry_limit: limit(env, "OBSERVATION_GRADING_RETRY_LIMIT", 3, true),
    run_concurrency: limit(env, "OBSERVATION_GRADING_RUN_CONCURRENCY", 2, true),
    stage_concurrency: limit(env, "OBSERVATION_GRADING_STAGE_CONCURRENCY", 1, true),
    run_spend: limit(env, "OBSERVATION_GRADING_RUN_SPEND", 1),
    stage_spend: limit(env, "OBSERVATION_GRADING_STAGE_SPEND", 0.5) };
}
export interface BudgetUsage { readonly run_claimed: number; readonly stage_claimed: number;
  readonly run_spend: number; readonly stage_spend: number;
  readonly run_reserved: number; readonly stage_reserved: number }
export function concurrencyExceeded(usage: BudgetUsage, caps: GradingLimits): boolean {
  return usage.run_claimed >= caps.run_concurrency || usage.stage_claimed >= caps.stage_concurrency;
}
export function spendExceeded(usage: BudgetUsage, estimated_cost: number, caps: GradingLimits): boolean {
  return estimated_cost > 0 && (usage.run_spend + usage.run_reserved + estimated_cost > caps.run_spend
    || usage.stage_spend + usage.stage_reserved + estimated_cost > caps.stage_spend);
}
