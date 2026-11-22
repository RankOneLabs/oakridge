import type { OperatorRunUsage, OperatorUsageReview } from "../operator-contracts/domain/usage";

// Matches the external review categories in the usage rollup.
const isHumanUsageReview = (review: OperatorUsageReview) =>
  review.kind === "human";

export function selectUsageCohorts(usage: OperatorRunUsage) {
  return usage.units.filter((unit) => unit.collection_key !== null).map((unit) => ({
    unit_id: unit.unit_id, label: unit.collection_key ?? unit.unit_id,
    first_pass_usd: unit.first_pass.usd, rework_usd: unit.rework.usd,
    agent_ms: unit.first_pass.agent_ms === null && unit.rework.agent_ms === null ? null : (unit.first_pass.agent_ms ?? 0) + (unit.rework.agent_ms ?? 0),
    human_wait_ms: unit.reviews.filter(isHumanUsageReview).reduce((total, review) => total + review.wait_ms, 0),
    approximate: unit.reviews.filter(isHumanUsageReview).some((review) => review.approximate),
  }));
}
export const selectUsageTotals = (usage: OperatorRunUsage) => ({ ...usage.totals, rework: usage.rework });
export const selectUsageCoverage = (usage: OperatorRunUsage) => ({
  ...usage.coverage,
  failed_session_count: usage.coverage.failed_sessions.length,
  completeness_warning: usage.coverage.failed_sessions.length > 0
    ? "Session reads failed; turn, token, time and cost totals may be incomplete."
    : null,
});
export const selectUsageVerification = (usage: OperatorRunUsage) => usage.verification;
export const selectUsageBasis = (basis: OperatorRunUsage["usd_basis"] | "provider_charged") =>
  basis === "list_price_equivalent" ? "list-price equivalent" : "provider charged";
export const formatUsageUsd = (usd: number | null) => usd === null ? "Unreported" : `$${usd.toFixed(2)}`;
/** Whole-second durations as `1h 2m 3s`, dropping leading zero units (`2m 5s`, `45s`). */
export const formatUsageDuration = (ms: number | null) => {
  if (ms === null) return "Unreported";
  const total_seconds = Math.round(ms / 1000);
  const hours = Math.floor(total_seconds / 3600);
  const minutes = Math.floor((total_seconds % 3600) / 60);
  const seconds = total_seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
};
export const formatUsageTokens = (count: number | null) => count === null ? "Unreported" : formatUsageCount(count);
export const formatUsageCount = (count: number) => count.toLocaleString("en-US");

export interface UsageStat { label: string; value: string; note: string | null }
export type UsageStatGroupKey = "cost" | "time" | "tokens" | "coverage";
export interface UsageStatGroup { key: UsageStatGroupKey; label: string; note: string | null; stats: UsageStat[] }

const stat = (label: string, value: string, note: string | null = null): UsageStat => ({ label, value, note });

/** Run totals grouped for display: cost (with its basis once), time, tokens and coverage counts. */
export function selectUsageStatGroups(usage: OperatorRunUsage): UsageStatGroup[] {
  const totals = selectUsageTotals(usage);
  const coverage = selectUsageCoverage(usage);
  const verification = selectUsageVerification(usage);
  return [
    { key: "cost", label: "Cost", note: selectUsageBasis(usage.usd_basis), stats: [
      stat("Run total", formatUsageUsd(totals.usd)),
      stat("Rework", formatUsageUsd(totals.rework.usd)),
      ...(verification ? [stat("Verification", formatUsageUsd(verification.usd), selectUsageBasis(verification.usd_basis))] : []),
    ] },
    { key: "time", label: "Time", note: null, stats: [
      stat("Agent", formatUsageDuration(totals.agent_ms)),
      stat("Human wait", formatUsageDuration(totals.human_wait_ms)),
      stat("External wait", formatUsageDuration(totals.external_wait_ms)),
      stat("Elapsed", formatUsageDuration(totals.elapsed_ms)),
    ] },
    { key: "tokens", label: "Tokens", note: null, stats: [
      stat("Total", formatUsageTokens(totals.tokens.total)),
      stat("Input", formatUsageTokens(totals.tokens.input)),
      stat("Output", formatUsageTokens(totals.tokens.output)),
      stat("Cached read", formatUsageTokens(totals.tokens.cached_read)),
      stat("Cached write", formatUsageTokens(totals.tokens.cached_write)),
      stat("Thought", formatUsageTokens(totals.tokens.thought)),
    ] },
    { key: "coverage", label: "Coverage", note: null, stats: [
      stat("Turns", formatUsageCount(coverage.turns)),
      stat("Reported", formatUsageCount(coverage.reported)),
      stat("Partial", formatUsageCount(coverage.partial)),
      stat("Absent", formatUsageCount(coverage.absent)),
      stat("Cost-unreported sessions", formatUsageCount(coverage.cost_unreported_sessions.length)),
      stat("Failed sessions", formatUsageCount(coverage.failed_session_count)),
    ] },
  ];
}
