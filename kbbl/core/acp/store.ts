// Typed repository over acp_sessions + acp_turns (migration 027). All
// SQLite access for the ACP substrate goes through this class — no raw
// queries in the controller/service. Mutations are idempotent where the
// domain allows (claim, accept) and transactional where two facts must
// move together (claim + insert, sweep).

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import type {
  AcpFailureCode,
  AcpSessionRow,
  AcpSessionSnapshot,
  AcpSessionStatus,
  AcpSessionStartSpec,
  AcpTurnRow,
  AcpTurnSource,
  AcpTurnStatus,
  KbblSessionId,
  ResumableKey,
  TurnKey,
} from "./types";

// Stable canonicalization matching the legacy resumable flow: sort object
// keys recursively, then sha256 the JSON. Same spec must hash identically
// regardless of property order in the HTTP body.
function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]),
  );
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function startSpecHash(spec: AcpSessionStartSpec): string {
  return sha256Hex(JSON.stringify(stableValue(spec)));
}

export interface ClaimInput {
  sid: KbblSessionId;
  resumable_key: ResumableKey | null;
  start_spec_hash: string | null;
  agent_profile: string;
  name: string;
  artifact_id: string | null;
  project_workdir: string;
  worktree_path: string;
  requested_model: string | null;
  requested_effort: string | null;
}

export type ClaimOutcome =
  | { kind: "created"; row: AcpSessionRow }
  | { kind: "existing"; row: AcpSessionRow }
  | { kind: "spec_conflict"; row: AcpSessionRow };

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

export interface BootSweepResult {
  turns_marked_unknown: number;
  turns_retained_accepted: number;
  sessions_marked_idle: number;
  sessions_marked_failed: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class AcpSessionStore {
  constructor(private readonly db: Database) {}

  /**
   * Idempotent resumable-key claim (§10.2 steps 1–2), one transaction:
   * absent key inserts a `provisioning` row; present key with the same
   * spec hash attaches; present key with a different hash is a conflict.
   */
  claimResumable(key: ResumableKey, input: ClaimInput): ClaimOutcome {
    return this.db.transaction((): ClaimOutcome => {
      const existing = this.getByResumableKey(key);
      if (existing) {
        if (existing.start_spec_hash !== input.start_spec_hash) {
          return { kind: "spec_conflict", row: existing };
        }
        return { kind: "existing", row: existing };
      }
      return { kind: "created", row: this.insertSession(input) };
    })();
  }

  insertSession(input: ClaimInput): AcpSessionRow {
    const ts = nowIso();
    return this.db
      .prepare<
        AcpSessionRow,
        [
          string,
          string | null,
          string | null,
          string,
          string,
          string | null,
          string,
          string,
          string | null,
          string | null,
          string,
          string,
          string,
        ]
      >(
        `INSERT INTO acp_sessions (
           sid, resumable_key, start_spec_hash, agent_profile, name,
           artifact_id, project_workdir, worktree_path, requested_model,
           requested_effort, status, last_activity_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'provisioning', ?, ?, ?)
         RETURNING *`,
      )
      .get(
        input.sid,
        input.resumable_key,
        input.start_spec_hash,
        input.agent_profile,
        input.name,
        input.artifact_id,
        input.project_workdir,
        input.worktree_path,
        input.requested_model,
        input.requested_effort,
        ts,
        ts,
        ts,
      )!;
  }

  getSession(sid: KbblSessionId): AcpSessionRow | null {
    return (
      this.db
        .prepare<AcpSessionRow, [string]>(
          "SELECT * FROM acp_sessions WHERE sid = ?",
        )
        .get(sid) ?? null
    );
  }

  getByResumableKey(key: ResumableKey): AcpSessionRow | null {
    return (
      this.db
        .prepare<AcpSessionRow, [string]>(
          "SELECT * FROM acp_sessions WHERE resumable_key = ?",
        )
        .get(key) ?? null
    );
  }

  listSessions(): AcpSessionRow[] {
    return this.db
      .prepare<AcpSessionRow, []>(
        "SELECT * FROM acp_sessions ORDER BY updated_at DESC",
      )
      .all();
  }

  setStatus(sid: KbblSessionId, status: AcpSessionStatus): void {
    const ts = nowIso();
    this.db
      .prepare(
        "UPDATE acp_sessions SET status = ?, updated_at = ? WHERE sid = ?",
      )
      .run(status, ts, sid);
  }

  setAcpSessionId(sid: KbblSessionId, acpSessionId: string): void {
    this.db
      .prepare(
        "UPDATE acp_sessions SET acp_session_id = ?, updated_at = ? WHERE sid = ?",
      )
      .run(acpSessionId, nowIso(), sid);
  }

  setWorktree(
    sid: KbblSessionId,
    worktree: {
      worktree_path: string;
      worktree_branch: string | null;
      worktree_base_ref: string | null;
      parent_sid: KbblSessionId | null;
      /** Original repo root; set on inheritance where it differs from spec.workdir. */
      project_workdir?: string;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE acp_sessions
         SET worktree_path = ?, worktree_branch = ?, worktree_base_ref = ?,
             parent_sid = ?, project_workdir = COALESCE(?, project_workdir),
             updated_at = ?
         WHERE sid = ?`,
      )
      .run(
        worktree.worktree_path,
        worktree.worktree_branch,
        worktree.worktree_base_ref,
        worktree.parent_sid,
        worktree.project_workdir ?? null,
        nowIso(),
        sid,
      );
  }

  listByArtifact(artifactId: string): AcpSessionRow[] {
    return this.db
      .prepare<AcpSessionRow, [string]>(
        "SELECT * FROM acp_sessions WHERE artifact_id = ? ORDER BY updated_at DESC",
      )
      .all(artifactId);
  }

  /** Hard delete (operator purge). Turn rows go with the session. */
  deleteSession(sid: KbblSessionId): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM acp_turns WHERE sid = ?").run(sid);
      this.db.prepare("DELETE FROM acp_sessions WHERE sid = ?").run(sid);
    })();
  }

  touchActivity(sid: KbblSessionId): void {
    const ts = nowIso();
    this.db
      .prepare(
        "UPDATE acp_sessions SET last_activity_at = ?, updated_at = ? WHERE sid = ?",
      )
      .run(ts, ts, sid);
  }

  markEnded(
    sid: KbblSessionId,
    status: Extract<AcpSessionStatus, "ended" | "fenced" | "failed">,
    endReason: string,
    fencedBy?: string,
  ): void {
    this.db
      .prepare(
        `UPDATE acp_sessions
         SET status = ?, end_reason = ?, fenced_by = COALESCE(?, fenced_by),
             updated_at = ?
         WHERE sid = ?`,
      )
      .run(status, endReason, fencedBy ?? null, nowIso(), sid);
  }

  /** §10.5 fence step 1: record the fencer before any teardown begins. */
  setFencedBy(sid: KbblSessionId, fencedBy: string): void {
    this.db
      .prepare(
        "UPDATE acp_sessions SET fenced_by = ?, updated_at = ? WHERE sid = ?",
      )
      .run(fencedBy, nowIso(), sid);
  }

  /** §10.6 advance: detach the key; the row stays queryable by sid. */
  clearResumableKey(sid: KbblSessionId): void {
    this.db
      .prepare(
        "UPDATE acp_sessions SET resumable_key = NULL, updated_at = ? WHERE sid = ?",
      )
      .run(nowIso(), sid);
  }

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
        )!;
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

  /** Oldest-first retained deliveries awaiting dispatch (§11.3). */
  listAcceptedTurns(sid: KbblSessionId): AcpTurnRow[] {
    return this.db
      .prepare<AcpTurnRow, [string]>(
        "SELECT * FROM acp_turns WHERE sid = ? AND status = 'accepted' ORDER BY created_at ASC, turn_key ASC",
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

  /**
   * Boot recovery sweep (§10.7), one transaction. `prompting` turns may
   * or may not have reached an agent — mark them unknown, never retry.
   * `accepted` turns provably never reached an agent — retain them for
   * exactly-once dispatch when the controller next becomes live.
   */
  bootSweep(): BootSweepResult {
    return this.db.transaction((): BootSweepResult => {
      const ts = nowIso();
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
        .get()!;
      const idleSessions = this.db
        .prepare(
          "UPDATE acp_sessions SET status = 'idle', updated_at = ? WHERE status = 'prompting'",
        )
        .run(ts);
      const failedSessions = this.db
        .prepare(
          `UPDATE acp_sessions
           SET status = 'failed', end_reason = 'kbbl_restart', updated_at = ?
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
  }
}

export function toSnapshot(row: AcpSessionRow): AcpSessionSnapshot {
  return {
    sid: row.sid,
    name: row.name,
    agent_profile: row.agent_profile,
    status: row.status,
    acp_session_id: row.acp_session_id,
    artifact_id: row.artifact_id,
    project_workdir: row.project_workdir,
    worktree_path: row.worktree_path,
    worktree_branch: row.worktree_branch,
    worktree_base_ref: row.worktree_base_ref,
    requested_model: row.requested_model,
    requested_effort: row.requested_effort,
    end_reason: row.end_reason,
    fenced_by: row.fenced_by,
    last_activity_at: row.last_activity_at,
    created_at: row.created_at,
  };
}
