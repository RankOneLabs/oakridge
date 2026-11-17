// Terminal session summaries (acp_session_summaries); the session facade delegates here.
import type { Database } from "bun:sqlite";
import type { KbblSessionId, TerminalSessionSummary, TerminalSessionSummaryDraft } from "./types";
import { nowIso } from "./store-records";

interface RawTerminalSessionSummary {
  sid: KbblSessionId;
  schema_version: number;
  method: TerminalSessionSummary["method"];
  summary_json: string;
  produced_at: string;
  created_at: string;
  updated_at: string;
}

export class AcpSummaryStore {
  constructor(private readonly db: Database) {}

  get(sid: KbblSessionId): TerminalSessionSummary | null {
    const row = this.db
      .prepare<RawTerminalSessionSummary, [KbblSessionId]>(
        "SELECT * FROM acp_session_summaries WHERE sid = ?",
      )
      .get(sid);
    if (!row) return null;
    let decoded: unknown;
    try {
      decoded = JSON.parse(row.summary_json);
    } catch {
      return null;
    }
    if (typeof decoded !== "object" || decoded === null || !("markdown" in decoded) || typeof decoded.markdown !== "string") {
      return null;
    }
    return {
      schema_version: 1,
      session_id: row.sid,
      method: row.method,
      produced_at: row.produced_at,
      markdown: decoded.markdown,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  put(summary: TerminalSessionSummaryDraft): TerminalSessionSummary {
    const timestamp = nowIso();
    this.db.prepare(
      `INSERT INTO acp_session_summaries
         (sid,schema_version,method,summary_json,produced_at,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(sid) DO UPDATE SET
         schema_version=excluded.schema_version,
         method=excluded.method,
         summary_json=excluded.summary_json,
         produced_at=excluded.produced_at,
         updated_at=excluded.updated_at`,
    ).run(
      summary.session_id,
      summary.schema_version,
      summary.method,
      JSON.stringify({ markdown: summary.markdown }),
      summary.produced_at,
      timestamp,
      timestamp,
    );
    const stored = this.get(summary.session_id);
    if (!stored) throw new Error(`failed to persist terminal summary for ${summary.session_id}`);
    return stored;
  }
}
