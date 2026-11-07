// Browser wire shape for sessions (§14.1): the one snapshot type the PWA
// consumes, shared by the /sessions list, POST /sessions, and the /inbox
// stream. Sourced from AcpSessionSnapshot. The agent-issued acp_session_id
// never crosses this boundary: it is not browser-facing identity.

import type {
  AcpSessionSnapshot,
  AcpSessionStatus,
  AcpSessionWorkflowIdentity,
} from "./types";

/** ACP is the session inventory. */
export type PwaSessionSource = "acp";

/** camelCase mirror of `AcpSessionWorkflowIdentity` on the browser wire. */
export interface PwaSessionWorkflowIdentity {
  runId: string;
  unitId: string;
  worker: string;
}

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
  archivedAt: string | null;
  /** Permission requests currently awaiting an operator answer. */
  pendingPermissionCount: number;
  workflow: PwaSessionWorkflowIdentity | null;
}

/** What one /inbox `changes` frame carries: sessions that are new or differ, and sessions that are gone. */
export interface PwaSessionChanges {
  sessions: PwaSessionSnapshot[];
  removedSids: string[];
}

export function selectPwaSessionChanges(
  previous: readonly PwaSessionSnapshot[],
  current: readonly PwaSessionSnapshot[],
): PwaSessionChanges {
  const previousBySid = new Map(previous.map((session) => [session.sid, JSON.stringify(session)]));
  const currentSids = new Set(current.map((session) => session.sid));
  return {
    sessions: current.filter((session) => previousBySid.get(session.sid) !== JSON.stringify(session)),
    removedSids: [...previousBySid.keys()].filter((sid) => !currentSids.has(sid)),
  };
}

function toPwaWorkflowIdentity(
  workflow: AcpSessionWorkflowIdentity | null,
): PwaSessionWorkflowIdentity | null {
  return workflow
    ? { runId: workflow.run_id, unitId: workflow.unit_id, worker: workflow.worker }
    : null;
}

export function toPwaSessionSnapshot(
  snapshot: AcpSessionSnapshot,
  pendingPermissionCount: number,
  archivedAt: string | null = null,
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
    archivedAt,
    pendingPermissionCount,
    workflow: toPwaWorkflowIdentity(snapshot.workflow),
  };
}
