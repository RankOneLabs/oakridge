import { AcpTurnStore, type AcceptTurnInput, type AcceptTurnOutcome, type OpenTurnRow, type RetainedPromptTurn, type BootSweepResult } from "./store-turns";
import { AcpWorktreeStore, type ReusableWorktreeClaimInput, type ReusableWorktreeClaim, type WorktreeAssignment } from "./store-worktrees";
import { nowIso, toAcpSessionRow, type RawAcpSessionRow } from "./store-records";
// Typed repository over acp_sessions + acp_turns (migration 027). All
// SQLite access for the ACP substrate goes through this class — no raw
// queries in the controller/service. Mutations are idempotent where the
// domain allows (claim, accept) and transactional where two facts must
// move together (claim + insert, sweep).

import type { Database } from "bun:sqlite";

import type {
  AcpSessionEnd,
  AcpSessionRow,
  AcpSessionStatus,
  AcpSessionWorkflowIdentity,
  AcpTurnRow,
  KbblSessionId,
  ResumableKey,
  TerminalSessionSummary,
  TerminalSessionSummaryDraft,
  TurnKey,
} from "./types";

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
  requested_mode: string | null;
  workflow: AcpSessionWorkflowIdentity | null;
}

export type ClaimOutcome =
  | { kind: "created"; row: AcpSessionRow }
  | { kind: "existing"; row: AcpSessionRow }
  | { kind: "spec_conflict"; row: AcpSessionRow };

interface RawTerminalSessionSummary {
  sid: KbblSessionId;
  schema_version: number;
  method: TerminalSessionSummary["method"];
  summary_json: string;
  produced_at: string;
  created_at: string;
  updated_at: string;
}

export class AcpSessionStore {
  private readonly sessionsChangedListeners = new Set<() => void>();

  private readonly turns: AcpTurnStore;
  private readonly worktrees: AcpWorktreeStore;
  constructor(private readonly db: Database) {
    this.turns = new AcpTurnStore(db);
    this.worktrees = new AcpWorktreeStore(db);
  }

  /**
   * Coarse change feed over the sessions table (§14.1 inbox): fired after
   * any write that can alter a session snapshot. Subscribers re-read; no
   * delta payloads — the snapshot is always the authority.
   */
  subscribeSessionsChanged(listener: () => void): () => void {
    this.sessionsChangedListeners.add(listener);
    return () => this.sessionsChangedListeners.delete(listener);
  }

  private notifySessionsChanged(): void {
    for (const listener of this.sessionsChangedListeners) listener();
  }

  /**
   * Idempotent resumable-key claim (§10.2 steps 1–2), one transaction:
   * absent key inserts a `provisioning` row; present key with the same
   * spec hash attaches; present key with a different hash is a conflict.
   * An attach onto a stored row with no identity yet backfills the
   * supplied one (one-way — a differing identity never overwrites a
   * stored non-null one, and is never a conflict: the spec hash is the
   * only conflict axis).
   */
  claimResumable(key: ResumableKey, input: ClaimInput): ClaimOutcome {
    return this.db.transaction((): ClaimOutcome => {
      const existing = this.getByResumableKey(key);
      if (existing) {
        if (existing.start_spec_hash !== input.start_spec_hash) {
          return { kind: "spec_conflict", row: existing };
        }
        if (existing.workflow === null && input.workflow !== null) {
          this.writeWorkflowIdentity(existing.sid, input.workflow);
          const updated = this.getSession(existing.sid);
          if (!updated) throw new Error("ACP workflow identity update lost its session");
          return { kind: "existing", row: updated };
        }
        return { kind: "existing", row: existing };
      }
      return { kind: "created", row: this.insertSession(input) };
    })();
  }

  private writeWorkflowIdentity(
    sid: KbblSessionId,
    workflow: AcpSessionWorkflowIdentity,
  ): void {
    this.db
      .prepare(
        `UPDATE acp_sessions SET run_id = ?, unit_id = ?, worker = ?, updated_at = ? WHERE sid = ?`,
      )
      .run(
        workflow.run_id,
        workflow.unit_id,
        workflow.worker,
        nowIso(),
        sid,
      );
    this.notifySessionsChanged();
  }

  insertSession(input: ClaimInput): AcpSessionRow {
    const ts = nowIso();
    const row = this.db
      .prepare<
        RawAcpSessionRow,
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
          string | null,
          string,
          string,
          string,
          string | null,
          string | null,
          string | null,
        ]
      >(
        `INSERT INTO acp_sessions (
           sid, resumable_key, start_spec_hash, agent_profile, name,
           artifact_id, project_workdir, worktree_path, requested_model,
           requested_effort, requested_mode, status, last_activity_at,
           created_at, updated_at, run_id, unit_id, worker
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'provisioning', ?, ?, ?, ?, ?, ?)
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
        input.requested_mode,
        ts,
        ts,
        ts,
        input.workflow?.run_id ?? null,
        input.workflow?.unit_id ?? null,
        input.workflow?.worker ?? null,
      );
    if (!row) throw new Error("ACP session insert returned no row");
    this.notifySessionsChanged();
    return toAcpSessionRow(row);
  }

  getSession(sid: KbblSessionId): AcpSessionRow | null {
    const row = this.db
      .prepare<RawAcpSessionRow, [string]>(
        "SELECT * FROM acp_sessions WHERE sid = ?",
      )
      .get(sid);
    return row ? toAcpSessionRow(row) : null;
  }

  getByResumableKey(key: ResumableKey): AcpSessionRow | null {
    const row = this.db
      .prepare<RawAcpSessionRow, [string]>(
        "SELECT * FROM acp_sessions WHERE resumable_key = ?",
      )
      .get(key);
    return row ? toAcpSessionRow(row) : null;
  }

  listSessions(): AcpSessionRow[] {
    return this.db
      .prepare<RawAcpSessionRow, []>(
        "SELECT * FROM acp_sessions ORDER BY updated_at DESC",
      )
      .all()
      .map(toAcpSessionRow);
  }

  /** Archive metadata is separate from execution state: archived sessions remain addressable. */
  archiveSession(sid: KbblSessionId): void {
    this.db.prepare(
      "INSERT OR IGNORE INTO acp_session_archives (sid, archived_at) VALUES (?, ?)",
    ).run(sid, nowIso());
    this.notifySessionsChanged();
  }

  listSessionArchives(): Map<KbblSessionId, string> {
    const rows = this.db.query<{ sid: KbblSessionId; archived_at: string }, []>(
      "SELECT sid, archived_at FROM acp_session_archives",
    ).all();
    return new Map(rows.map((row) => [row.sid, row.archived_at]));
  }

  claimReusableWorktree(input: ReusableWorktreeClaimInput): ReusableWorktreeClaim | null {
    const claimed = this.worktrees.claimReusableWorktree(input);
    if (claimed) this.notifySessionsChanged();
    return claimed;
  }
  markPurgeStarted(sid: KbblSessionId): AcpSessionRow | null {
    const row = this.worktrees.markPurgeStarted(sid);
    if (row) this.notifySessionsChanged();
    return row;
  }
  hasOtherBranchClaimant(sid: KbblSessionId, projectWorkdir: string, branch: string): boolean {
    return this.worktrees.hasOtherBranchClaimant(sid, projectWorkdir, branch);
  }
  hasOtherWorktreeOwner(sid: KbblSessionId, worktreePath: string, worktreeBranch: string): boolean {
    return this.worktrees.hasOtherWorktreeOwner(sid, worktreePath, worktreeBranch);
  }

  setStatus(sid: KbblSessionId, status: AcpSessionStatus): void {
    const ts = nowIso();
    this.db
      .prepare(
        "UPDATE acp_sessions SET status = ?, updated_at = ? WHERE sid = ?",
      )
      .run(status, ts, sid);
    this.notifySessionsChanged();
  }

  /** Reopen an ended resumable row after its ACP session has been loaded. */
  reviveEnded(sid: KbblSessionId): boolean {
    const changed = this.db.prepare(
      `UPDATE acp_sessions SET status = 'idle', end_reason = NULL, end_detail = NULL, updated_at = ?
       WHERE sid = ? AND status IN ('ended', 'failed') AND fenced_by IS NULL`,
    ).run(nowIso(), sid).changes > 0;
    if (changed) this.notifySessionsChanged();
    return changed;
  }

  setRequestedMode(sid: KbblSessionId, mode: string): void {
    this.db
      .prepare(
        "UPDATE acp_sessions SET requested_mode = ?, updated_at = ? WHERE sid = ?",
      )
      .run(mode, nowIso(), sid);
  }

  setAcpSessionId(sid: KbblSessionId, acpSessionId: string): void {
    this.db
      .prepare(
        "UPDATE acp_sessions SET acp_session_id = ?, updated_at = ? WHERE sid = ?",
      )
      .run(acpSessionId, nowIso(), sid);
    this.notifySessionsChanged();
  }

  setWorktree(sid: KbblSessionId, worktree: WorktreeAssignment): void {
    this.worktrees.setWorktree(sid, worktree);
    this.notifySessionsChanged();
  }

  listByArtifact(artifactId: string): AcpSessionRow[] {
    return this.db
      .prepare<RawAcpSessionRow, [string]>(
        "SELECT * FROM acp_sessions WHERE artifact_id = ? ORDER BY updated_at DESC",
      )
      .all(artifactId)
      .map(toAcpSessionRow);
  }

  getSessionSummary(sid: KbblSessionId): TerminalSessionSummary | null {
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

  putSessionSummary(summary: TerminalSessionSummaryDraft): TerminalSessionSummary {
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
    const stored = this.getSessionSummary(summary.session_id);
    if (!stored) throw new Error(`failed to persist terminal summary for ${summary.session_id}`);
    return stored;
  }

  /** Hard delete (operator purge). Turn rows go with the session. */
  deleteSession(sid: KbblSessionId): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM acp_turns WHERE sid = ?").run(sid);
      this.db.prepare("DELETE FROM acp_sessions WHERE sid = ?").run(sid);
    })();
    this.notifySessionsChanged();
  }

  touchActivity(sid: KbblSessionId): void {
    const ts = nowIso();
    this.db
      .prepare(
        "UPDATE acp_sessions SET last_activity_at = ?, updated_at = ? WHERE sid = ?",
      )
      .run(ts, ts, sid);
    this.notifySessionsChanged();
  }

  markEnded(sid: KbblSessionId, end: AcpSessionEnd): void {
    this.db
      .prepare(
        `UPDATE acp_sessions
         SET status = ?, end_reason = ?, end_detail = ?,
             fenced_by = COALESCE(?, fenced_by), updated_at = ?
         WHERE sid = ?`,
      )
      .run(
        end.status,
        end.reason,
        end.detail ?? null,
        end.fenced_by ?? null,
        nowIso(),
        sid,
      );
    this.notifySessionsChanged();
  }

  /** §10.5 fence step 1: record the fencer before any teardown begins. */
  setFencedBy(sid: KbblSessionId, fencedBy: string): void {
    this.db
      .prepare(
        "UPDATE acp_sessions SET fenced_by = ?, updated_at = ? WHERE sid = ?",
      )
      .run(fencedBy, nowIso(), sid);
    this.notifySessionsChanged();
  }

  /** §10.6 advance: detach the key; the row stays queryable by sid. */
  clearResumableKey(sid: KbblSessionId): void {
    this.db
      .prepare(
        "UPDATE acp_sessions SET resumable_key = NULL, updated_at = ? WHERE sid = ?",
      )
      .run(nowIso(), sid);
    this.notifySessionsChanged();
  }

  acceptTurn(input: AcceptTurnInput): AcceptTurnOutcome { return this.turns.acceptTurn(input); }
  getTurn(sid: KbblSessionId, turnKey: TurnKey): AcpTurnRow | null { return this.turns.getTurn(sid, turnKey); }
  getInitialTurn(sid: KbblSessionId): AcpTurnRow | null { return this.turns.getInitialTurn(sid); }
  hasDispatchedTurns(sid: KbblSessionId): boolean { return this.turns.hasDispatchedTurns(sid); }
  readPromptTurns(sid: KbblSessionId): RetainedPromptTurn[] | null { return this.turns.readPromptTurns(sid); }
  listAcceptedTurns(sid: KbblSessionId): AcpTurnRow[] { return this.turns.listAcceptedTurns(sid); }
  listOpenTurns(sid: KbblSessionId): OpenTurnRow[] { return this.turns.listOpenTurns(sid); }
  markTurnPrompting(sid: KbblSessionId, turnKey: TurnKey): void { this.turns.markTurnPrompting(sid, turnKey); }
  completeTurn(sid: KbblSessionId, turnKey: TurnKey, outcome: Parameters<AcpTurnStore["completeTurn"]>[2]): void {
    this.turns.completeTurn(sid, turnKey, outcome);
  }
  bootSweep(): BootSweepResult {
    const result = this.turns.bootSweep();
    this.notifySessionsChanged();
    return result;
  }
}
