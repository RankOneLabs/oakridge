import type { ActionId, RunId, UnitId } from "./primitives";
/** Wire fields mirror kbbl/core/acp/usage-types.ts SessionUsage and usage-parsers/types.ts. */
export interface WireCounters { input_tokens: number | null; output_tokens: number | null; cached_read_tokens: number | null; cached_write_tokens: number | null; thought_tokens: number | null; total_tokens: number | null }
export interface WireModelUsage extends Omit<WireCounters, "total_tokens"> { model: string }
export interface WireTurnUsage extends WireCounters { sid: string; turn_key: string; status: "reported" | "partial" | "absent"; model_usage: WireModelUsage[] | null; raw_json: string | null; recorded_at: string }
export interface UsageTurn { turn_key: string; source: "initial" | "operator" | "collaboration"; status: "accepted" | "prompting" | "succeeded" | "cancelled" | "failed" | "unknown"; created_at: string; started_at: string | null; completed_at: string | null; usage: WireTurnUsage | null }
export interface UsageReading { seq: number; process_seq: number; context_used: number | null; context_size: number | null; cost_amount: number | null; cost_currency: string | null; active_turn_key: string | null; autonomous: boolean; origin_kind: string | null; received_at: string }
export interface KbblUsage { sid: string; turns: UsageTurn[]; readings: UsageReading[] }
export interface UsageTokens { input: number | null; output: number | null; cached_read: number | null; cached_write: number | null; thought: number | null; total: number | null }
export interface UsageAmount { tokens: UsageTokens; usd: number | null; agent_ms: number | null }
export interface AttributedTurn extends UsageAmount { sid: string; turn_key: string; source: UsageTurn["source"]; kind: "delivered" | "incidental"; status: UsageTurn["status"]; coverage: "reported" | "partial" | "absent"; queue_ms: number | null }
export interface UsageBackground { usd: number | null }
export interface UsageAttempt extends UsageAmount { action_id: ActionId; seq: number; worker: string; rework: boolean; turns: AttributedTurn[]; background: UsageBackground }
export interface UsageReview { review: string; decision: string; wait_ms: number; approximate: boolean }
export interface UsageUnit { unit_id: UnitId; stage: string | null; collection_key: string | null; first_pass: UsageAmount; rework: UsageAmount; attempts: UsageAttempt[]; reviews: UsageReview[] }
export interface UsageTotals extends UsageAmount { human_wait_ms: number; external_wait_ms: number; elapsed_ms: number }
export interface UsageVerification { usd: number; usd_basis: "provider_charged" }
export interface UsageCoverage { turns: number; reported: number; partial: number; absent: number; cost_unreported_sessions: string[]; failed_sessions: string[] }
export interface RunUsage {
  run_id: RunId; usd_basis: "list_price_equivalent";
  totals: UsageTotals;
  rework: UsageAmount;
  verification: UsageVerification | null;
  coverage: UsageCoverage;
  units: UsageUnit[];
  unattributed: AttributedTurn[];
}
