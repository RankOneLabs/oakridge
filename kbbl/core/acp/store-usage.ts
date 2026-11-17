import type { Database } from "bun:sqlite";
import type { AcpTurnRow, AcpTurnUsageRow, AcpUsageReadingRow, KbblSessionId, SessionUsage } from "#kbbl/core/acp/types";
import { nowIso } from "#kbbl/core/acp/store-records";
export type UsageReadingInput = Omit<AcpUsageReadingRow, "seq" | "received_at" | "autonomous"> & { autonomous: boolean };
type UsageTurnRow = Pick<AcpTurnRow, "turn_key" | "source" | "status" | "created_at" | "started_at" | "completed_at">;

export class AcpUsageStore {
  constructor(private readonly db: Database) {}
  nextProcessSeq(sid: KbblSessionId): number {
    return this.db.prepare<{ next: number }, [string]>("SELECT COALESCE(MAX(process_seq) + 1, 0) AS next FROM acp_usage_reading WHERE sid = ?").get(sid)?.next ?? 0;
  }
  appendReading(row: UsageReadingInput): void {
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO acp_usage_reading
        (sid, seq, process_seq, context_used, context_size, cost_amount, cost_currency, active_turn_key, autonomous, origin_kind, received_at)
        SELECT ?, COALESCE(MAX(seq) + 1, 0), ?,?,?,?,?,?,?,?,? FROM acp_usage_reading WHERE sid = ?`).run(
        row.sid, row.process_seq, row.context_used, row.context_size, row.cost_amount, row.cost_currency,
        row.active_turn_key, Number(row.autonomous), row.origin_kind, nowIso(), row.sid,
      );
    })();
  }
  read(sid: KbblSessionId): SessionUsage {
    const turns = this.db.prepare<UsageTurnRow, [string]>("SELECT turn_key, source, status, created_at, started_at, completed_at FROM acp_turns WHERE sid = ? ORDER BY created_at, rowid").all(sid);
    const usage = this.db.prepare<AcpTurnUsageRow, [string]>("SELECT * FROM acp_turn_usage WHERE sid = ?").all(sid);
    const byKey = new Map(usage.map(row => [row.turn_key, row]));
    return {
      sid,
      turns: turns.map(({ turn_key, source, status, created_at, started_at, completed_at }) => {
        const row = byKey.get(turn_key);
        const parsed = row ? (({ model_usage_json, ...rest }) => ({
          ...rest, model_usage: model_usage_json === null ? null : JSON.parse(model_usage_json),
        }))(row) : null;
        return { turn_key, source, status, created_at, started_at, completed_at, usage: parsed };
      }),
      readings: this.db.prepare<AcpUsageReadingRow, [string]>("SELECT * FROM acp_usage_reading WHERE sid = ? ORDER BY seq").all(sid)
        .map(({ sid, autonomous, ...row }) => ({ ...row, autonomous: autonomous === 1 })),
    };
  }
}
