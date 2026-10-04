import type { JsonValue } from "./primitives";
import type { StageOperatorRole } from "./workflow";

/**
 * The workflow identity a delegated session is launched for — forwarded to
 * kbbl (migration 029's `acp_sessions` columns) so the session list can
 * group a cohort's build and assessment sessions together. `run_id` and
 * `stage_instance_id` name the execution; `unit_id` is the fan-out item (or
 * `"0"` for a scalar stage); `operator_role`, `cohort_title` and
 * `repository_key` are the human-facing labels a grouped session list
 * renders.
 */
export interface SessionIdentity {
  readonly run_id: string;
  readonly stage_instance_id: string;
  readonly unit_id: string;
  readonly cohort_id: string | null;
  readonly operator_role: StageOperatorRole | null;
  readonly cohort_title: string | null;
  readonly repository_key: string | null;
}

/**
 * The agent runtimes a delegated session can run on.
 *
 * Named because the pair was spelled out inline everywhere it was checked — the
 * execution resolver, the kbbl adapter, the launch boundary — and a set that
 * has to be re-typed at every check is a set that grows in some of them.
 */
export const DELEGATED_RUNTIME_IDS = ["claude-code", "codex"] as const;
export type DelegatedRuntimeId = (typeof DELEGATED_RUNTIME_IDS)[number];
export const isDelegatedRuntimeId = (value: unknown): value is DelegatedRuntimeId =>
  DELEGATED_RUNTIME_IDS.includes(value as DelegatedRuntimeId);

export interface WorktreeIdentity { readonly branchName: string; readonly worktreeSubdir: string; readonly baseRef?: string }

/**
 * Adapter-owned name for why a role is being launched. Core carries the name
 * but does not close over an adapter's vocabulary.
 */
export type SessionLaunchReasonName = string;

/** Durable reference from a session to the transition that launched it. */
export interface SessionLaunchReason {
  readonly transition_id: import("./primitives").RunTransitionId;
  readonly name: SessionLaunchReasonName;
}

/** Immutable launch material selected by, and readable from, one transition. */
export interface CommittedSessionLaunch {
  readonly reason: SessionLaunchReason;
  readonly session_role: StageOperatorRole;
  readonly prompt: { readonly template_path: string; readonly content: string };
  readonly existing_pull_request: string | null;
}

export interface ResolvedExecutorConfig {
  readonly executor_type: "delegated_session";
  readonly runtime: DelegatedRuntimeId;
  readonly rendered_prompt: string;
  readonly workdir: string;
  readonly session_name: string;
  readonly model: string | null;
  readonly effort: string | null;
  readonly worktree?: WorktreeIdentity;
  readonly executor_options: JsonValue;
  readonly session_identity: SessionIdentity;
}
