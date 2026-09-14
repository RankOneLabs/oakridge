// Typed repository over acp_sessions + acp_turns (migration 027). All
// SQLite access for the ACP substrate goes through this class — no raw
// queries in the controller/service. Mutations are idempotent where the
// domain allows (claim, accept) and transactional where two facts must
// move together (claim + insert, sweep).

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import type {
  AcpFailureCode,
  AcpSessionEnd,
  AcpSessionRow,
  AcpSessionSnapshot,
  AcpSessionStatus,
  AcpSessionStartSpec,
  AcpSessionWorkflowIdentity,
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
  workflow: AcpSessionWorkflowIdentity | null;
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

export type OpenTurnRow = AcpTurnRow & {
  status: Extract<AcpTurnStatus, "accepted" | "prompting">;
};

/** Worktree columns written once resolution finishes (setWorktree). */
export interface WorktreeAssignment {
  worktree_path: string;
  worktree_branch: string | null;
  worktree_base_ref: string | null;
  parent_sid: KbblSessionId | null;
  /** Original repo root; set on inheritance where it differs from spec.workdir. */
  project_workdir?: string;
}

export interface BootSweepResult {
  turns_marked_unknown: number;
  turns_retained_accepted: number;
  sessions_marked_idle: number;
  sessions_marked_failed: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * `acp_sessions`' actual column shape: the workflow identity is six flat
 * nullable TEXT columns, not the nested object `AcpSessionRow` exposes.
 * Every `SELECT *`/`RETURNING *` reads this shape; `toAcpSessionRow`
 * assembles the nested `workflow` member consumers see.
 */
interface RawAcpSessionRow {
  sid: KbblSessionId;
  resumable_key: ResumableKey | null;
  start_spec_hash: string | null;
  agent_profile: string;
  acp_session_id: string | null;
  name: string;
  artifact_id: string | null;
  project_workdir: string;
  worktree_path: string;
  worktree_branch: string | null;
  worktree_base_ref: string | null;
  parent_sid: KbblSessionId | null;
  requested_model: string | null;
  requested_effort: string | null;
  status: AcpSessionStatus;
  end_reason: string | null;
  end_detail: string | null;
  fenced_by: string | null;
  last_activity_at: string;
  created_at: string;
  updated_at: string;
  workflow_run_id: string | null;
  stage_instance_id: string | null;
  stage_unit_id: string | null;
  operator_role: string | null;
  cohort_title: string | null;
  repository_key: string | null;
}

/** Absence is the nullable: yields `null` unless all three required columns are non-null. */
function toAcpSessionRow(raw: RawAcpSessionRow): AcpSessionRow {
  const {
    workflow_run_id,
    stage_instance_id,
    stage_unit_id,
    operator_role,
    cohort_title,
    repository_key,
    ...rest
  } = raw;
  const workflow: AcpSessionWorkflowIdentity | null =
    workflow_run_id !== null && stage_instance_id !== null && stage_unit_id !== null
      ? {
          workflow_run_id,
          stage_instance_id,
          unit_id: stage_unit_id,
          operator_role,
          cohort_title,
          repository_key,
        }
      : null;
  return { ...rest, workflow } as AcpSessionRow;
}

export class AcpSessionStore {
  private readonly sessionsChangedListeners = new Set<() => void>();

  constructor(private readonly db: Database) {}

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
          return { kind: "existing", row: this.getSession(existing.sid)! };
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
        `UPDATE acp_sessions
         SET workflow_run_id = ?, stage_instance_id = ?, stage_unit_id = ?,
             operator_role = ?, cohort_title = ?, repository_key = ?, updated_at = ?
         WHERE sid = ?`,
      )
      .run(
        workflow.workflow_run_id,
        workflow.stage_instance_id,
        workflow.unit_id,
        workflow.operator_role,
        workflow.cohort_title,
        workflow.repository_key,
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
          string,
          string,
          string,
          string | null,
          string | null,
          string | null,
          string | null,
          string | null,
          string | null,
        ]
      >(
        `INSERT INTO acp_sessions (
           sid, resumable_key, start_spec_hash, agent_profile, name,
           artifact_id, project_workdir, worktree_path, requested_model,
           requested_effort, status, last_activity_at, created_at, updated_at,
           workflow_run_id, stage_instance_id, stage_unit_id, operator_role,
           cohort_title, repository_key
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'provisioning', ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        input.workflow?.workflow_run_id ?? null,
        input.workflow?.stage_instance_id ?? null,
        input.workflow?.unit_id ?? null,
        input.workflow?.operator_role ?? null,
        input.workflow?.cohort_title ?? null,
        input.workflow?.repository_key ?? null,
      )!;
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

  setStatus(sid: KbblSessionId, status: AcpSessionStatus): void {
    const ts = nowIso();
    this.db
      .prepare(
        "UPDATE acp_sessions SET status = ?, updated_at = ? WHERE sid = ?",
      )
      .run(status, ts, sid);
    this.notifySessionsChanged();
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

  /** Whether a prompt may have reached the agent, including uncertain outcomes. */
  hasDispatchedTurns(sid: KbblSessionId): boolean {
    return this.db.prepare<{ found: number }, [string]>(
      "SELECT 1 AS found FROM acp_turns WHERE sid = ? AND (status <> 'accepted' OR started_at IS NOT NULL) LIMIT 1",
    ).get(sid) !== null;
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

  /**
   * Boot recovery sweep (§10.7), one transaction. `prompting` turns may
   * or may not have reached an agent — mark them unknown, never retry.
   * `accepted` turns provably never reached an agent — retain them for
   * exactly-once dispatch when the controller next becomes live.
   */
  bootSweep(): BootSweepResult {
    const result = this.db.transaction((): BootSweepResult => {
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
    this.notifySessionsChanged();
    return result;
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
    end_detail: row.end_detail,
    fenced_by: row.fenced_by,
    last_activity_at: row.last_activity_at,
    created_at: row.created_at,
    workflow: row.workflow,
  };
}
