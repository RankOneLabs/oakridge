// Browser wire shape for sessions (§14.1): the one snapshot type the PWA
// consumes, shared by the /sessions list, POST /sessions, and the /inbox
// stream. Sourced from AcpSessionSnapshot; archived pre-ACP sessions
// project into the same shape so the client keeps a single model. The
// agent-issued acp_session_id never crosses this boundary — it is not
// browser-facing identity.

import type { AcpSessionSnapshot, AcpSessionStatus } from "./types";

/** Where a listed session's record lives. `legacy_archive` rows are
 * pre-cutover JSONL sessions: listable, closed, transcript not viewable
 * since the ACP cutover (reconstruction is deleted with the legacy
 * machinery). */
export type PwaSessionSource = "acp" | "legacy_archive";

export interface PwaSessionSnapshot {
  sid: string;
  name: string;
  agentProfile: string;
  status: AcpSessionStatus;
  source: PwaSessionSource;
  lastActivityTs: string;
  createdAt: string;
  artifactId: string | null;
  projectWorkdir: string;
  worktreePath: string;
  worktreeBranch: string | null;
  worktreeBaseRef: string | null;
  requestedModel: string | null;
  requestedEffort: string | null;
  endReason: string | null;
  fencedBy: string | null;
  /** Permission requests currently awaiting an operator answer. */
  pendingPermissionCount: number;
}

export function toPwaSessionSnapshot(
  snapshot: AcpSessionSnapshot,
  pendingPermissionCount: number,
): PwaSessionSnapshot {
  return {
    sid: snapshot.sid,
    name: snapshot.name,
    agentProfile: snapshot.agent_profile,
    status: snapshot.status,
    source: "acp",
    lastActivityTs: snapshot.last_activity_at,
    createdAt: snapshot.created_at,
    artifactId: snapshot.artifact_id,
    projectWorkdir: snapshot.project_workdir,
    worktreePath: snapshot.worktree_path,
    worktreeBranch: snapshot.worktree_branch,
    worktreeBaseRef: snapshot.worktree_base_ref,
    requestedModel: snapshot.requested_model,
    requestedEffort: snapshot.requested_effort,
    endReason: snapshot.end_reason,
    fencedBy: snapshot.fenced_by,
    pendingPermissionCount,
  };
}

/**
 * The subset of the legacy on-disk SessionSnapshot this projection needs.
 * Mirrors core/session/types.ts fields; typed structurally so this module
 * never imports the legacy session tree (which PR 6 deletes).
 */
export interface LegacyArchivedSnapshotFields {
  sid: string;
  name: string;
  workdir: string;
  createdAt: string;
  lastActivityTs: string;
  runtimeId: string;
  artifactId: string | null;
  worktreePath: string | null;
  worktreeBranch: string | null;
  worktreeBaseRef: string | null;
  projectWorkdir: string | null;
  model: string | null;
  effort: string | null;
  endReason: string | null;
}

export function archivedLegacyToPwaSnapshot(
  snapshot: LegacyArchivedSnapshotFields,
): PwaSessionSnapshot {
  return {
    sid: snapshot.sid,
    name: snapshot.name,
    agentProfile: snapshot.runtimeId,
    status: "ended",
    source: "legacy_archive",
    lastActivityTs: snapshot.lastActivityTs,
    createdAt: snapshot.createdAt,
    artifactId: snapshot.artifactId,
    projectWorkdir: snapshot.projectWorkdir ?? snapshot.workdir,
    worktreePath: snapshot.worktreePath ?? snapshot.workdir,
    worktreeBranch: snapshot.worktreeBranch,
    worktreeBaseRef: snapshot.worktreeBaseRef,
    requestedModel: snapshot.model,
    requestedEffort: snapshot.effort,
    endReason: snapshot.endReason,
    fencedBy: null,
    pendingPermissionCount: 0,
  };
}
