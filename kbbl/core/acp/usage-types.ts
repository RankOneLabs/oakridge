import type { AcpTurnRow, KbblSessionId, TurnKey } from "#kbbl/core/acp/types";
import type { ModelUsage, UsageCounters } from "#kbbl/core/acp/usage-parsers/types";
// Usage rows and the public GET /sessions/:sid/usage contract; tables from migration 006_turn_usage.sql.
export interface AcpTurnUsageRow extends UsageCounters {
  sid: KbblSessionId;
  turn_key: TurnKey;
  status: "reported" | "partial" | "absent";
  model_usage_json: string | null;
  raw_json: string | null;
  recorded_at: string;
}
export interface AcpUsageReadingRow {
  sid: KbblSessionId; seq: number; process_seq: number;
  context_used: number | null; context_size: number | null;
  cost_amount: number | null; cost_currency: string | null;
  active_turn_key: TurnKey | null; autonomous: number; origin_kind: string | null; received_at: string;
}
export interface SessionUsage {
  sid: KbblSessionId;
  turns: (Pick<AcpTurnRow, "turn_key" | "source" | "status" | "created_at" | "started_at" | "completed_at"> & {
    usage: (Omit<AcpTurnUsageRow, "model_usage_json"> & { model_usage: ModelUsage[] | null }) | null;
  })[];
  readings: (Omit<AcpUsageReadingRow, "sid" | "autonomous"> & { autonomous: boolean })[];
}
