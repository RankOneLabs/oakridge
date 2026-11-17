import type { OperatorRunUsage } from "../operator-contracts/domain/usage";

export function selectUsageCohorts(usage: OperatorRunUsage) {
  return usage.units.filter((unit) => unit.stage === "cohort").map((unit) => ({
    unit_id: unit.unit_id, label: unit.collection_key ?? unit.unit_id,
    first_pass_usd: unit.first_pass.usd, rework_usd: unit.rework.usd,
    agent_ms: unit.first_pass.agent_ms === null && unit.rework.agent_ms === null ? null : (unit.first_pass.agent_ms ?? 0) + (unit.rework.agent_ms ?? 0),
    human_wait_ms: unit.reviews.reduce((total, review) => total + review.wait_ms, 0),
    approximate: unit.reviews.some((review) => review.approximate),
  }));
}
export const selectUsageTotals = (usage: OperatorRunUsage) => ({ ...usage.totals, rework: usage.rework });
export const selectUsageCoverage = (usage: OperatorRunUsage) => usage.coverage;
export const selectUsageVerification = (usage: OperatorRunUsage) => usage.verification;
export const selectUsageBasis = (basis: OperatorRunUsage["usd_basis"] | "provider_charged") =>
  basis === "list_price_equivalent" ? "list-price equivalent" : "provider charged";
export const formatUsageUsd = (usd: number | null) => usd === null ? "Unreported" : `$${usd.toFixed(2)}`;
export const formatUsageDuration = (ms: number | null) => ms === null ? "Unreported" : `${(ms / 1000).toFixed(1)}s`;
export const formatUsageTokens = (count: number | null) => count === null ? "Unreported" : count.toLocaleString("en-US");
