// Worktree ownership SQL remains transactional; the session facade emits change notifications.
import type { Database } from "bun:sqlite";
import type { AcpSessionRow, KbblSessionId } from "./types";
import { nowIso, toAcpSessionRow, type RawAcpSessionRow } from "./store-records";

/** Worktree columns written once resolution finishes (setWorktree). */
export interface WorktreeAssignment {
  worktree_path: string;
  worktree_branch: string | null;
  worktree_base_ref: string | null;
  parent_sid: KbblSessionId | null;
  /** Original repo root; set on inheritance where it differs from spec.workdir. */
  project_workdir?: string;
}

/** Atomic transfer result when a workflow retry takes over an existing checkout. */
export interface ReusableWorktreeClaim extends WorktreeAssignment {
  worktree_branch: string;
  worktree_base_ref: string;
  parent_sid: KbblSessionId;
  project_workdir: string;
}

export interface ReusableWorktreeClaimInput {
  sid: KbblSessionId;
  project_workdir: string;
  worktree_branch: string;
}

export class AcpWorktreeStore {
  constructor(private readonly db: Database) {}

  /**
   * Transfer a deterministic workflow checkout from its terminal owner to a
   * provisioning retry. Selection and both ownership writes share one SQLite
   * transaction, so two retries cannot start agents in the same directory.
   */
  claimReusableWorktree(input: ReusableWorktreeClaimInput): ReusableWorktreeClaim | null {
    const claimed = this.db.transaction((): ReusableWorktreeClaim | null => {
      const replacement = this.db.prepare<RawAcpSessionRow, [string]>("SELECT * FROM acp_sessions WHERE sid = ?").get(input.sid);
      if (!replacement || replacement.status !== "provisioning") return null;

      const owner = this.db
        .prepare<RawAcpSessionRow, [string, string, string]>(
          `SELECT owner.* FROM acp_sessions owner
           WHERE owner.project_workdir = ? AND owner.worktree_branch = ?
             AND owner.status IN ('ended', 'fenced', 'failed')
             AND COALESCE(owner.fenced_by, '') NOT LIKE 'purge:%'
             AND NOT EXISTS (
               SELECT 1 FROM acp_sessions active
               WHERE active.sid != owner.sid AND active.sid != ?
                 AND active.status NOT IN ('ended', 'fenced', 'failed')
                 AND (
                   active.worktree_branch = owner.worktree_branch
                   OR active.worktree_path = owner.worktree_path
                 )
             )
           ORDER BY owner.updated_at DESC LIMIT 1`,
        )
        .get(input.project_workdir, input.worktree_branch, input.sid);
      if (!owner || !owner.worktree_branch || !owner.worktree_base_ref) return null;

      const ts = nowIso();
      const released = this.db
        .prepare(
          `UPDATE acp_sessions
           SET worktree_path = project_workdir, worktree_branch = NULL,
               worktree_base_ref = NULL, updated_at = ?
           WHERE sid = ? AND worktree_branch = ?
             AND status IN ('ended', 'fenced', 'failed')
             AND COALESCE(fenced_by, '') NOT LIKE 'purge:%'`,
        )
        .run(ts, owner.sid, owner.worktree_branch);
      if (released.changes !== 1) return null;

      const assigned = this.db
        .prepare(
          `UPDATE acp_sessions
           SET project_workdir = ?, worktree_path = ?, worktree_branch = ?,
               worktree_base_ref = ?, parent_sid = ?, updated_at = ?
           WHERE sid = ? AND status = 'provisioning'`,
        )
        .run(
          owner.project_workdir,
          owner.worktree_path,
          owner.worktree_branch,
          owner.worktree_base_ref,
          owner.sid,
          ts,
          input.sid,
        );
      if (assigned.changes !== 1) throw new Error("replacement worktree claim was lost");

      return {
        worktree_path: owner.worktree_path,
        worktree_branch: owner.worktree_branch,
        worktree_base_ref: owner.worktree_base_ref,
        parent_sid: owner.sid,
        project_workdir: owner.project_workdir,
      };
    })();
    return claimed;
  }

  /** Mark cleanup before its first await so no retry can claim this checkout. */
  markPurgeStarted(sid: KbblSessionId): AcpSessionRow | null {
    const row = this.db
      .prepare<RawAcpSessionRow, [string, string, string]>(
        `UPDATE acp_sessions SET fenced_by = ?, updated_at = ?
         WHERE sid = ? RETURNING *`,
      )
      .get(`purge:${sid}`, nowIso(), sid);
    return row ? toAcpSessionRow(row) : null;
  }

  /**
   * Whether another session records `branch` in `projectWorkdir`, or is still
   * provisioning there and may be creating it now. A branch no session claims
   * was left behind by a crash.
   */
  hasOtherBranchClaimant(sid: KbblSessionId, projectWorkdir: string, branch: string): boolean {
    const row = this.db
      .prepare<{ present: number }, [string, string, string]>(
        `SELECT 1 AS present FROM acp_sessions
         WHERE sid != ? AND project_workdir = ? AND (worktree_branch = ? OR status = 'provisioning')
         LIMIT 1`,
      )
      .get(sid, projectWorkdir, branch);
    return row !== null;
  }

  hasOtherWorktreeOwner(
    sid: KbblSessionId,
    worktreePath: string,
    worktreeBranch: string,
  ): boolean {
    const row = this.db
      .prepare<{ present: number }, [string, string, string]>(
        `SELECT 1 AS present FROM acp_sessions
         WHERE sid != ? AND (worktree_path = ? OR worktree_branch = ?)
         LIMIT 1`,
      )
      .get(sid, worktreePath, worktreeBranch);
    return row !== null;
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
  }
}
