// Generated from oakridge-dbos/src/http/operator-api.ts. Run bun kbbl/scripts/generate-operator-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

export interface OperatorRunUsage {
  run_id: string; usd_basis: "list_price_equivalent";
  totals: OperatorUsageTotals;
  rework: OperatorUsageAmount;
  verification: OperatorUsageVerification | null;
  coverage: OperatorUsageCoverage;
  units: OperatorUsageUnit[];
  unattributed: OperatorAttributedTurn[];
}

export interface OperatorUsageTotals extends OperatorUsageAmount { human_wait_ms: number; external_wait_ms: number; elapsed_ms: number }

export interface OperatorUsageAmount { tokens: OperatorUsageTokens; usd: number | null; agent_ms: number | null }

export interface OperatorUsageVerification { usd: number; usd_basis: "provider_charged" }

export interface OperatorUsageCoverage { turns: number; reported: number; partial: number; absent: number; cost_unreported_sessions: string[]; failed_sessions: string[] }

export interface OperatorUsageUnit { unit_id: string; stage: string | null; collection_key: string | null; first_pass: OperatorUsageAmount; rework: OperatorUsageAmount; attempts: OperatorUsageAttempt[]; reviews: OperatorUsageReview[] }

export interface OperatorAttributedTurn extends OperatorUsageAmount { sid: string; turn_key: string; source: OperatorUsageTurn["source"]; kind: "delivered" | "incidental"; status: OperatorUsageTurn["status"]; coverage: "reported" | "partial" | "absent"; queue_ms: number | null }

export interface OperatorUsageTokens { input: number | null; output: number | null; cached_read: number | null; cached_write: number | null; thought: number | null; total: number | null }

export interface OperatorUsageAttempt extends OperatorUsageAmount { action_id: string; seq: number; worker: string; rework: boolean; turns: OperatorAttributedTurn[]; background: OperatorUsageBackground }

export interface OperatorUsageReview { review: string; decision: string; kind: "human" | "external"; wait_ms: number; approximate: boolean }

export interface OperatorUsageTurn { turn_key: string; source: "initial" | "operator" | "collaboration"; status: "accepted" | "prompting" | "succeeded" | "cancelled" | "failed" | "unknown"; created_at: string; started_at: string | null; completed_at: string | null; usage: OperatorWireTurnUsage | null }

export interface OperatorUsageBackground { usd: number | null }

export interface OperatorWireTurnUsage extends OperatorWireCounters { sid: string; turn_key: string; status: "reported" | "partial" | "absent"; model_usage: OperatorWireModelUsage[] | null; raw_json: string | null; recorded_at: string }

export interface OperatorWireCounters { input_tokens: number | null; output_tokens: number | null; cached_read_tokens: number | null; cached_write_tokens: number | null; thought_tokens: number | null; total_tokens: number | null }

export interface OperatorWireModelUsage extends Omit<OperatorWireCounters, "total_tokens"> { model: string }
