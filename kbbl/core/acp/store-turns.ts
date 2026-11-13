// Typed turn persistence and boot recovery; the session facade owns change notifications.
import type { Database } from "bun:sqlite";
import type { ExecutedPromptTurn } from "../executed-prompt";
import type { AcpFailureCode, AcpTurnRow, AcpTurnSource, AcpTurnStatus, KbblSessionId, TurnKey } from "./types";
import { nowIso } from "./store-records";
import { sha256Hex } from "./start-spec-hash";

/** Internal read includes the recorded dispatch boundary; never serialized directly. */
export interface RetainedPromptTurn extends ExecutedPromptTurn {
  readonly started_at: AcpTurnRow["started_at"];
}

export interface AcceptTurnInput {
  sid: KbblSessionId;
  turn_key: TurnKey;
  source: AcpTurnSource;
  payload: string;
}

export type AcceptTurnOutcome =
  | { kind: "created"; row: AcpTurnRow }
  | { kind: "existing"; row: AcpTurnRow }
  | { kind: "payload_conflict"; row: AcpTurnRow };

export type OpenTurnRow = AcpTurnRow & {
  status: Extract<AcpTurnStatus, "accepted" | "prompting">;
};

export interface BootSweepResult {
  turns_marked_unknown: number;
  turns_retained_accepted: number;
  sessions_marked_idle: number;
  sessions_marked_failed: number;
}

export class AcpTurnStore {
  constructor(private readonly db: Database) {}

  /**
   * Idempotent turn accept (§9.3): same key + same hash returns the prior
   * row; same key + different hash is a payload conflict; otherwise the
   * turn is inserted as `accepted`.
   */
  acceptTurn(input: AcceptTurnInput): AcceptTurnOutcome {
    const payloadHash = sha256Hex(input.payload);
    return this.db.transaction((): AcceptTurnOutcome => {
      const existing = this.getTurn(input.sid, input.turn_key);
      if (existing) {
        if (existing.payload_hash !== payloadHash) {
          return { kind: "payload_conflict", row: existing };
        }
        return { kind: "existing", row: existing };
      }
      const row = this.db
        .prepare<AcpTurnRow, [string, string, string, string, string, string]>(
          `INSERT INTO acp_turns (
             sid, turn_key, source, payload_hash, payload, status, created_at
           ) VALUES (?, ?, ?, ?, ?, 'accepted', ?)
           RETURNING *`,
        )
        .get(
          input.sid,
          input.turn_key,
          input.source,
          payloadHash,
          input.payload,
          nowIso(),
        );
      if (!row) throw new Error("ACP turn insert returned no row");
      return { kind: "created", row };
    })();
  }

  getTurn(sid: KbblSessionId, turnKey: TurnKey): AcpTurnRow | null {
    return (
      this.db
        .prepare<AcpTurnRow, [string, string]>(
          "SELECT * FROM acp_turns WHERE sid = ? AND turn_key = ?",
        )
        .get(sid, turnKey) ?? null
    );
  }

  getInitialTurn(sid: KbblSessionId): AcpTurnRow | null {
    return (
      this.db
        .prepare<AcpTurnRow, [string]>(
          "SELECT * FROM acp_turns WHERE sid = ? AND source = 'initial' ORDER BY created_at ASC LIMIT 1",
        )
        .get(sid) ?? null
    );
  }

  /** Whether a prompt may have reached the agent, including uncertain outcomes. */
  hasDispatchedTurns(sid: KbblSessionId): boolean {
    return this.db.prepare<{ found: number }, [string]>(
      "SELECT 1 AS found FROM acp_turns WHERE sid = ? AND (status <> 'accepted' OR started_at IS NOT NULL) LIMIT 1",
    ).get(sid) !== null;
  }

  /** Retained prompt payloads in creation order; only the redaction boundary may serialize these. */
  readPromptTurns(sid: KbblSessionId): RetainedPromptTurn[] | null {
    if (!this.db.prepare<{ found: number }, [string]>("SELECT 1 AS found FROM acp_sessions WHERE sid = ?").get(sid)) return null;
    const turns = this.db.prepare<RetainedPromptTurn, [string]>(
      "SELECT turn_key AS turn_id, created_at, payload AS text, started_at FROM acp_turns WHERE sid = ? ORDER BY created_at ASC, rowid ASC",
    ).all(sid);
    return turns.length === 0 ? null : turns;
  }

  /** Oldest-first retained deliveries awaiting dispatch (§11.3). */
  listAcceptedTurns(sid: KbblSessionId): AcpTurnRow[] {
    return this.db
      .prepare<AcpTurnRow, [string]>(
        "SELECT * FROM acp_turns WHERE sid = ? AND status = 'accepted' ORDER BY created_at ASC, rowid ASC",
      )
      .all(sid);
  }

  listOpenTurns(sid: KbblSessionId): OpenTurnRow[] {
    return this.db
      .prepare<OpenTurnRow, [string]>(
        "SELECT * FROM acp_turns WHERE sid = ? AND status IN ('accepted', 'prompting') ORDER BY created_at ASC, rowid ASC",
      )
      .all(sid);
  }

  /**
   * §10.7 ordering rule: written in its own transaction BEFORE
   * session/prompt is sent, so a crash can distinguish "never reached the
   * agent" (accepted) from "may have" (prompting).
   */
  markTurnPrompting(sid: KbblSessionId, turnKey: TurnKey): void {
    const ts = nowIso();
    this.db
      .prepare(
        "UPDATE acp_turns SET status = 'prompting', started_at = ? WHERE sid = ? AND turn_key = ?",
      )
      .run(ts, sid, turnKey);
  }

  completeTurn(
    sid: KbblSessionId,
    turnKey: TurnKey,
    outcome: {
      status: Extract<
        AcpTurnStatus,
        "succeeded" | "cancelled" | "failed" | "unknown"
      >;
      stop_reason?: string;
      failure_code?: AcpFailureCode;
      failure_detail?: string;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE acp_turns
         SET status = ?, stop_reason = ?, failure_code = ?, failure_detail = ?,
             completed_at = ?
         WHERE sid = ? AND turn_key = ?`,
      )
      .run(
        outcome.status,
        outcome.stop_reason ?? null,
        outcome.failure_code ?? null,
        outcome.failure_detail ?? null,
        nowIso(),
        sid,
        turnKey,
      );
  }

  /** Boot recovery sweep, one transaction. */
  bootSweep(): BootSweepResult {
    const result = this.db.transaction((): BootSweepResult => {
      const ts = nowIso();
      this.db.prepare(
        `UPDATE acp_turns
         SET status = 'accepted', completed_at = NULL, failure_code = NULL, failure_detail = NULL
         WHERE source = 'initial' AND status IN ('prompting', 'unknown')
           AND sid IN (SELECT sid FROM acp_sessions WHERE resumable_key IS NOT NULL
             AND status NOT IN ('failed', 'fenced', 'ended'))`,
      ).run();
      const unknownTurns = this.db
        .prepare(
          `UPDATE acp_turns
           SET status = 'unknown', failure_code = 'kbbl_restart',
               failure_detail = 'kbbl restarted while the turn was prompting',
               completed_at = ?
           WHERE status = 'prompting'`,
        )
        .run(ts);
      const retained = this.db
        .prepare<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM acp_turns WHERE status = 'accepted'",
        )
        .get();
      if (!retained) throw new Error("ACP accepted turn count returned no row");
      const idleSessions = this.db
        .prepare(
          "UPDATE acp_sessions SET status = 'idle', updated_at = ? WHERE status = 'prompting'",
        )
        .run(ts);
      const failedSessions = this.db
        .prepare(
          `UPDATE acp_sessions
           SET status = 'failed', end_reason = 'kbbl_restart',
               end_detail = 'kbbl restarted while the session was provisioning',
               updated_at = ?
           WHERE status = 'provisioning'`,
        )
        .run(ts);
      return {
        turns_marked_unknown: unknownTurns.changes,
        turns_retained_accepted: retained.n,
        sessions_marked_idle: idleSessions.changes,
        sessions_marked_failed: failedSessions.changes,
      };
    })();
    return result;
  }
}
