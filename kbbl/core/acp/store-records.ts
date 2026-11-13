import type { AcpSessionRow, AcpSessionStatus, AcpSessionWorkflowIdentity, KbblSessionId, ResumableKey } from "./types";

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * `acp_sessions`' actual column shape: the workflow identity is three flat
 * nullable TEXT columns, not the nested object `AcpSessionRow` exposes.
 * Every `SELECT *`/`RETURNING *` reads this shape; `toAcpSessionRow`
 * assembles the nested `workflow` member consumers see.
 */
export interface RawAcpSessionRow {
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
  requested_mode: string | null;
  status: AcpSessionStatus;
  end_reason: string | null;
  end_detail: string | null;
  fenced_by: string | null;
  last_activity_at: string;
  created_at: string;
  updated_at: string;
  run_id: string | null;
  unit_id: string | null;
  worker: string | null;
}

/** Absence is the nullable: yields `null` unless all three columns are non-null. */
export function toAcpSessionRow(raw: RawAcpSessionRow): AcpSessionRow {
  const { run_id, unit_id, worker, ...rest } = raw;
  const workflow: AcpSessionWorkflowIdentity | null =
    run_id !== null && unit_id !== null && worker !== null ? { run_id, unit_id, worker } : null;
  return { ...rest, workflow } as AcpSessionRow;
}
