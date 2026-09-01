// Domain model for the ACP session substrate (migration spec §8–§13, §18).
// Row shapes mirror migration 027_acp_sessions.sql; the start-spec shape
// mirrors the DBOS-facing HTTP contract (§11.1). Everything here is
// provider-neutral: no Claude/Codex knowledge belongs in this module tree.

import type * as schema from "@agentclientprotocol/sdk";

// === Local primitives ===

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

export function err<E>(error: E): { ok: false; error: E } {
  return { ok: false, error };
}

// === Identifiers ===

/** kbbl-owned stable session identity (routes, DBOS kbbl_session refs). */
export type KbblSessionId = string & { readonly __brand: "KbblSessionId" };
/** Agent-issued opaque session id. Never parsed, never shown as identity. */
export type AcpAgentSessionId = string & {
  readonly __brand: "AcpAgentSessionId";
};
/** DBOS deterministic resumable key (idempotent ensure). */
export type ResumableKey = string & { readonly __brand: "ResumableKey" };
/** Idempotency key for one prompt turn (`initial:<key>` or a delivery key). */
export type TurnKey = string & { readonly __brand: "TurnKey" };

// === Failure codes (§18) ===

export type AcpFailureCode =
  | "agent_profile_unavailable"
  | "agent_spawn_failed"
  | "acp_initialize_failed"
  | "acp_protocol_mismatch"
  | "acp_required_capability_missing"
  | "acp_session_new_failed"
  | "acp_session_load_failed"
  | "acp_config_unsupported"
  | "acp_prompt_failed"
  | "acp_transport_lost"
  | "acp_process_exited"
  | "acp_cancel_failed"
  | "acp_close_failed"
  | "session_busy"
  | "session_fenced"
  | "session_key_conflict"
  | "delivery_key_conflict"
  | "worktree_failed"
  | "requested_model_unsupported"
  | "requested_effort_unsupported"
  | "session_not_found"
  | "kbbl_restart";

/** Domain error with trace context: operation, entity, detail. */
export interface AcpError {
  readonly code: AcpFailureCode;
  readonly operation: string;
  readonly sid?: KbblSessionId;
  readonly detail: string;
}

export function acpError(
  code: AcpFailureCode,
  operation: string,
  detail: string,
  sid?: KbblSessionId,
): AcpError {
  return { code, operation, detail, sid };
}

// === Durable rows (mirror 027_acp_sessions.sql) ===

export type AcpSessionStatus =
  | "provisioning"
  | "idle"
  | "prompting"
  | "ended"
  | "fenced"
  | "failed"
  | "unknown";

export interface AcpSessionRow {
  sid: KbblSessionId;
  resumable_key: ResumableKey | null;
  start_spec_hash: string | null;
  agent_profile: string;
  acp_session_id: AcpAgentSessionId | null;
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
  fenced_by: string | null;
  last_activity_at: string;
  created_at: string;
  updated_at: string;
}

export type AcpTurnSource = "initial" | "operator" | "collaboration";

export type AcpTurnStatus =
  | "accepted"
  | "prompting"
  | "succeeded"
  | "cancelled"
  | "failed"
  | "unknown";

export interface AcpTurnRow {
  sid: KbblSessionId;
  turn_key: TurnKey;
  source: AcpTurnSource;
  payload_hash: string;
  /** User input text — durable so retained accepted turns can dispatch. */
  payload: string;
  user_message_id: string | null;
  status: AcpTurnStatus;
  stop_reason: string | null;
  failure_code: AcpFailureCode | null;
  failure_detail: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

// === Session start spec (mirrors §11.1 ensure request body) ===

export interface AcpSessionStartSpec {
  readonly initial_prompt: string;
  readonly workdir: string;
  readonly name?: string;
  readonly artifact_id?: string;
  /** Agent profile id. Property named for DBOS wire compatibility (§11.1). */
  readonly runtime?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly worktree?: {
    readonly branch_name: string;
    readonly worktree_subdir: string;
    readonly base_ref?: string;
  };
  readonly inherit_worktree_from?: string;
}

// === Worktree port (§17) ===
//
// Worktrees stay kbbl-owned; the controller only ever sees the final
// absolute cwd. PR 2 ships the port; the git-backed adapter (wrapping
// core/session/worktree.ts) arrives with the provider cutover.

export interface WorktreeResolution {
  readonly worktree_path: string;
  readonly worktree_branch: string | null;
  readonly worktree_base_ref: string | null;
  readonly parent_sid: KbblSessionId | null;
  /**
   * Original repo root when it differs from spec.workdir (worktree
   * inheritance: the child runs in a worktree cut from the parent's
   * worktree, but its project identity stays the original repo).
   */
  readonly project_workdir?: string;
}

export interface WorktreeProvider {
  resolve(
    sid: KbblSessionId,
    spec: AcpSessionStartSpec,
  ): Promise<Result<WorktreeResolution, AcpError>>;
  /** Best-effort removal on purge; optional (test providers omit it). */
  remove?(row: {
    project_workdir: string;
    worktree_path: string;
    worktree_branch: string | null;
  }): Promise<void>;
}

// === Service-facing shapes (§8.6) ===

export interface AcpSessionSnapshot {
  sid: KbblSessionId;
  name: string;
  agent_profile: string;
  status: AcpSessionStatus;
  acp_session_id: AcpAgentSessionId | null;
  artifact_id: string | null;
  project_workdir: string;
  worktree_path: string;
  worktree_branch: string | null;
  worktree_base_ref: string | null;
  requested_model: string | null;
  requested_effort: string | null;
  end_reason: string | null;
  fenced_by: string | null;
  last_activity_at: string;
  created_at: string;
}

export type EnsureResult =
  | { kind: "created"; session: AcpSessionSnapshot }
  | { kind: "existing"; session: AcpSessionSnapshot };

/** §10.6 operator advance: detach a wedged key after fencing its session. */
export type AdvanceResult =
  | { kind: "not_found" }
  | { kind: "advanced"; session: AcpSessionSnapshot };

export interface InputReceipt {
  readonly sid: KbblSessionId;
  readonly turn_key: TurnKey;
  readonly payload_hash: string;
  readonly status: AcpTurnStatus;
  readonly created_at: string;
}

/**
 * Settlement read for orchestrator dispatch attempts. ACP sessions outlive
 * their work — a durable session sitting idle after its initial turn
 * succeeded is DONE work, not running work — so dispatch completion derives
 * from the initial turn, never from session liveness.
 */
export type AcpDispatchStatus = "running" | "completed" | "failed";

/**
 * Terminal observation over the INITIAL turn (§11.2): pending until that
 * turn reaches a known final outcome; the agent process staying alive
 * afterwards does not make the session non-terminal.
 */
export type TerminalObservation =
  | { kind: "pending"; session: AcpSessionSnapshot }
  | { kind: "succeeded"; session: AcpSessionSnapshot }
  | {
      kind: "failed";
      session: AcpSessionSnapshot;
      failure_code: AcpFailureCode;
      failure_detail: string;
    };

export interface FenceContext {
  readonly fenced_by: string;
}

export interface UiSessionHistory {
  readonly sid: KbblSessionId;
  readonly events: readonly AcpUiEvent[];
  /** True when the agent could not replay (expired/unsupported history). */
  readonly expired: boolean;
}

// === UI projection (§13.1) ===
//
// The browser never sees raw ACP payloads; the projector normalizes ACP
// (not provider) semantics into this union.

export interface UiContent {
  readonly type: "text";
  readonly text: string;
}

export interface UiToolLocation {
  readonly path: string;
  readonly line?: number | null;
}

export interface UiPlanEntry {
  readonly content: string;
  readonly status: string;
  readonly priority: string;
}

export interface UiPermissionOption {
  readonly optionId: string;
  readonly name: string;
  readonly kind?: string | null;
}

export interface UiSessionConfig {
  readonly id: string;
  readonly name: string;
  readonly category: string | null;
  readonly type: "select" | "boolean";
  readonly value: unknown;
  readonly options: readonly { value: string; name: string }[];
}

export interface UiAvailableCommand {
  readonly name: string;
  readonly description: string | null;
}

export type AcpUiEvent =
  | { kind: "user_message"; id: string; content: UiContent[]; replayed: boolean }
  | {
      kind: "agent_message";
      id: string;
      content: UiContent[];
      streaming: boolean;
      replayed: boolean;
    }
  | {
      kind: "thought";
      id: string;
      content: UiContent[];
      streaming: boolean;
      replayed: boolean;
    }
  | {
      kind: "tool_call";
      toolCallId: string;
      title: string;
      status: string;
      content: unknown;
      locations?: readonly UiToolLocation[];
    }
  | { kind: "plan"; entries: readonly UiPlanEntry[] }
  | {
      kind: "permission";
      requestId: string;
      title: string;
      options: readonly UiPermissionOption[];
    }
  | { kind: "config_options"; options: readonly UiSessionConfig[] }
  | { kind: "commands"; commands: readonly UiAvailableCommand[] }
  | { kind: "session_info"; title?: string | null; updatedAt?: string | null }
  | {
      kind: "usage";
      used?: number;
      size?: number;
      cost?: { amount: number; currency: string };
    }
  | {
      kind: "turn_state";
      state: "prompting" | "idle" | "cancelled" | "failed" | "unknown";
      stopReason?: string;
      detail?: string;
    };

// === Re-exported ACP schema aliases used across the module tree ===

export type SessionUpdate = schema.SessionUpdate;
export type SessionNotification = schema.SessionNotification;
export type PromptResponse = schema.PromptResponse;
export type StopReason = schema.StopReason;
export type SessionConfigOption = schema.SessionConfigOption;
export type AgentCapabilities = schema.AgentCapabilities;
export type RequestPermissionRequest = schema.RequestPermissionRequest;
export type RequestPermissionResponse = schema.RequestPermissionResponse;
