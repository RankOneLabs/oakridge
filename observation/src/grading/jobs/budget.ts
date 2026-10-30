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
const positive = (raw: string | undefined, fallback: number): number => {
  const value = Number(raw);
  return raw && Number.isFinite(value) && value > 0 ? value : fallback;
};
export function gradingLimits(env: NodeJS.ProcessEnv = process.env): GradingLimits {
  const provider_deadline_ms = positive(env.OBSERVATION_PROVIDER_DEADLINE_MS, 30_000);
  return { provider_deadline_ms, lease_ms: Math.max(provider_deadline_ms + 5_000,
    positive(env.OBSERVATION_GRADING_LEASE_MS, 45_000)),
    retry_limit: Math.floor(positive(env.OBSERVATION_GRADING_RETRY_LIMIT, 3)),
    run_concurrency: Math.floor(positive(env.OBSERVATION_GRADING_RUN_CONCURRENCY, 2)),
    stage_concurrency: Math.floor(positive(env.OBSERVATION_GRADING_STAGE_CONCURRENCY, 1)),
    run_spend: positive(env.OBSERVATION_GRADING_RUN_SPEND, 1),
    stage_spend: positive(env.OBSERVATION_GRADING_STAGE_SPEND, 0.5) };
}
export interface BudgetUsage { readonly run_claimed: number; readonly stage_claimed: number;
  readonly run_spend: number; readonly stage_spend: number;
  readonly run_reserved: number; readonly stage_reserved: number }
export function budgetExceeded(usage: BudgetUsage, estimated_cost: number, caps: GradingLimits): boolean {
  return usage.run_claimed >= caps.run_concurrency || usage.stage_claimed >= caps.stage_concurrency
    || usage.run_spend + usage.run_reserved + estimated_cost > caps.run_spend
    || usage.stage_spend + usage.stage_reserved + estimated_cost > caps.stage_spend;
}
