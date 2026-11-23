import type { OperatorRunUsage, OperatorUsageAmount } from "../operator-contracts/domain/usage";
const amount: OperatorUsageAmount = { usd: 2, agent_ms: 1000, tokens: { input: 1, output: 2, cached_read: 0, cached_write: 0, thought: 0, total: 3 } };
export const usageFixture: OperatorRunUsage = {
  run_id: "run", usd_basis: "list_price_equivalent", totals: { ...amount, human_wait_ms: 2000, external_wait_ms: 3000, elapsed_ms: 6000 }, rework: { ...amount, usd: 1 }, verification: { usd: 0.5, usd_basis: "provider_charged" },
  coverage: { turns: 0, reported: 0, partial: 0, absent: 0, cost_unreported_sessions: [], failed_sessions: [] }, unattributed: [],
  units: ["one", "two", "planning"].map((key) => ({ unit_id: key, collection_key: key === "planning" ? null : key, stage: key === "planning" ? "planning" : "cohort", first_pass: amount, rework: { ...amount, usd: 1 }, attempts: [], reviews: [{ review: "approval", kind: "human" as const, decision: "accept", wait_ms: 2000, approximate: true }] })),
};
