// Git-backed WorktreeProvider (§17): the production adapter behind the
// ACP substrate's worktree port. Worktrees remain kbbl-owned — the ACP
// controller only ever receives the final absolute cwd. All git shelling
// stays in core/session/worktree.ts; this module owns the policy of which
// worktree a session gets:
//
// - fresh session:            new worktree `kbbl/<sid8>` cut from workdir HEAD
// - DBOS identity worktree:   branch/subdir/base exactly as requested
// - inherit_worktree_from:    a NEW worktree cut from the parent session's
//   worktree (depth-suffixed branch), preserving the legacy resume-chain
//   semantics — never the same directory, never a provider-session lookup
//   (§17.3: kbbl stores worktree metadata directly).

import type { AcpSessionStore } from "../acp/store";
import {
  acpError,
  err,
  ok,
  type AcpError,
  type AcpSessionStartSpec,
  type KbblSessionId,
  type Result,
  type WorktreeProvider,
  type WorktreeResolution,
} from "../acp/types";
import {
  createWorktree,
  isGitRepo,
  removeWorktree,
  WorktreeCreateError,
  selectWorktreeFailureDetail,
} from "../session/worktree";

/** Resume-chain depth encoded in a branch name (`...-r<n>`), 0 otherwise. */
export function parseDepthFromBranch(branch: string | null): number {
  const match = branch?.match(/-r(\d+)$/);
  return match ? Number(match[1]) : 0;
}

/** How to cut one worktree: source checkout, chain depth, DBOS identity. */
interface CreateWorktreeOptions {
  workdir: string;
  resumeDepth: number;
  identity?: { branchName: string; worktreeSubdir: string };
  baseRef?: string;
}

export interface GitWorktreeProviderDeps {
  /** `<dataDir>/<worktree_dir_name>` — parent of all per-session worktrees. */
  readonly worktreesRoot: string;
  /** For resolving `inherit_worktree_from` parents by sid. */
  readonly store: AcpSessionStore;
}

export class GitWorktreeProvider implements WorktreeProvider {
  constructor(private readonly deps: GitWorktreeProviderDeps) {}

  async resolve(
    sid: KbblSessionId,
    spec: AcpSessionStartSpec,
  ): Promise<Result<WorktreeResolution, AcpError>> {
    if (spec.inherit_worktree_from !== undefined) {
      return this.resolveInherited(sid, spec.inherit_worktree_from);
    }

    let isRepo: boolean;
    try {
      isRepo = await isGitRepo(spec.workdir);
    } catch (error) {
      return err(
        acpError(
          "worktree_failed",
          "worktree.resolve",
          error instanceof Error ? error.message : String(error),
          sid,
        ),
      );
    }
    if (!isRepo) {
      return err(
        acpError(
          "worktree_failed",
          "worktree.resolve",
          `workdir ${spec.workdir} is not a git repository`,
          sid,
        ),
      );
    }

    return this.createFor(sid, {
      workdir: spec.workdir,
      resumeDepth: 0,
      identity: spec.worktree
        ? {
            branchName: spec.worktree.branch_name,
            worktreeSubdir: spec.worktree.worktree_subdir,
          }
        : undefined,
      baseRef: spec.worktree?.base_ref,
    });
  }

  /**
   * Best-effort worktree removal for an operator purge. Follows the legacy
   * contract: failures are logged, never thrown — the caller has already
   * committed to deleting the session.
   */
  async remove(row: {
    project_workdir: string;
    worktree_path: string;
    worktree_branch: string | null;
  }): Promise<void> {
    if (row.worktree_branch === null) return;
    if (row.worktree_path === row.project_workdir) return;
    await removeWorktree({
      workdir: row.project_workdir,
      worktreePath: row.worktree_path,
      worktreeBranch: row.worktree_branch,
    });
  }

  private async resolveInherited(
    sid: KbblSessionId,
    parentSid: string,
  ): Promise<Result<WorktreeResolution, AcpError>> {
    const parent = this.deps.store.getSession(parentSid as KbblSessionId);
    if (!parent) {
      // Pre-cutover legacy sessions live in JSONL, not acp_sessions; a
      // run whose lineage predates the ACP cutover must re-anchor with an
      // explicit worktree spec instead of inheriting across backends.
      return err(
        acpError(
          "worktree_failed",
          "worktree.resolveInherited",
          `inherit_worktree_from ${parentSid} is not a known ACP session (legacy sessions cannot be inherited across the cutover)`,
          sid,
        ),
      );
    }
    const depth = parseDepthFromBranch(parent.worktree_branch) + 1;
    const created = await this.createFor(sid, {
      workdir: parent.worktree_path,
      resumeDepth: depth,
    });
    if (!created.ok) return created;
    return ok({
      ...created.value,
      parent_sid: parent.sid,
      project_workdir: parent.project_workdir,
    });
  }

  private async createFor(
    sid: KbblSessionId,
    opts: CreateWorktreeOptions,
  ): Promise<Result<WorktreeResolution, AcpError>> {
    try {
      const created = await createWorktree({
        workdir: opts.workdir,
        worktreesRoot: this.deps.worktreesRoot,
        oakridgeSid: sid,
        resumeDepth: opts.resumeDepth,
        ...(opts.identity ? { identity: opts.identity } : {}),
        ...(opts.baseRef ? { baseRef: opts.baseRef } : {}),
      });
      return ok({
        worktree_path: created.worktreePath,
        worktree_branch: created.worktreeBranch,
        worktree_base_ref: created.worktreeBaseRef,
        parent_sid: null,
      });
    } catch (error) {
      const detail =
        error instanceof WorktreeCreateError
          ? selectWorktreeFailureDetail(error)
          : error instanceof Error
            ? error.message
            : String(error);
      return err(acpError("worktree_failed", "worktree.create", detail, sid));
    }
  }
}
