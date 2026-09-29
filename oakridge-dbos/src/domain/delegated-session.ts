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

export type SlotBinding =
  | { readonly from: "input"; readonly input_name: string; readonly path?: string | null }
  | { readonly from: "context"; readonly path: string }
  | { readonly from: "literal"; readonly value: string }
  | { readonly from: "item"; readonly path: string }
  | { readonly from: "context_lookup"; readonly collection_path: string; readonly collection_key_path: string; readonly item_key_path: string; readonly value_path: string }
  /**
   * `context_lookup`'s sibling, keyed off a named input instead of the run
   * context. A fan-out unit needs values chosen by something it carries — a
   * cohort looking up the repository it builds in — and `input` alone cannot
   * key off the item. The difference from `context_lookup` is only where the
   * collection comes from: an upstream stage's typed output rather than a
   * pointer into an untyped bag.
   */
  | { readonly from: "input_lookup"; readonly input_name: string; readonly collection_key_path: string; readonly item_key_path: string; readonly value_path: string };

export type Bindable = string | SlotBinding;
export interface WorktreeIdentity { readonly branchName: string; readonly worktreeSubdir: string; readonly baseRef?: string }
export interface WorktreeTemplate { readonly branch_name: Bindable; readonly worktree_subdir: Bindable; readonly base_ref?: Bindable }

export interface FanOutDefinition {
  readonly over: SlotBinding;
  readonly unit_id_path: string;
  readonly session_mode?: "per_unit" | "shared";
  readonly depends_on_path?: string | null;
  readonly max_parallel?: number;
  readonly manual_admission?: boolean;
  readonly item_bindings?: Readonly<Record<string, SlotBinding>>;
  readonly workdir?: SlotBinding;
  readonly inherit_worktree_from?: string;
}

export interface ArtifactCollectionDefinition { readonly over: SlotBinding; readonly id_path: string }
export interface OutputGateStep { readonly type: "artifact_approval" | "merge_confirmation"; readonly actions: readonly string[] }
export interface OutputGateDefinition {
  readonly name: string;
  readonly outputs: readonly string[];
  readonly steps: readonly OutputGateStep[];
  readonly requires_zero_open_review_items?: boolean;
}
export interface OutputHandoffDefinition {
  readonly name: string;
  readonly outputs: readonly string[];
  readonly downstream_role: StageOperatorRole;
  readonly approved_wait: { readonly kind: string; readonly close_events: readonly string[] };
}

/** Why the scheduler is starting or resuming a delegated role. */
export type SessionLaunchReason = "initial" | "operator_retry" | "input_revision";

/** One cell in the role × launch-reason prompt matrix. */
export interface PromptMatrixEntry {
  readonly session_role: StageOperatorRole;
  readonly launch_reason: SessionLaunchReason;
  readonly template_path: string;
}

/** Runtime policy belongs to a session role, including its worktree. */
export interface DelegatedSessionRoleConfig {
  readonly session_role: StageOperatorRole;
  readonly runtime: Bindable;
  readonly session_name: string;
  readonly model?: Bindable;
  readonly effort?: Bindable;
  readonly worktree?: WorktreeTemplate;
  readonly pre_authorized_tools?: readonly string[];
  readonly required_tools?: readonly string[];
  readonly authorized_outputs: readonly string[];
  readonly yolo?: boolean;
}

/** Exact definition-time JSON contract retained from Rust v2. */
export interface DelegatedSessionDefinitionConfig {
  readonly prompt_matrix: readonly PromptMatrixEntry[];
  readonly role_configs: readonly DelegatedSessionRoleConfig[];
  readonly slot_bindings: Readonly<Record<string, SlotBinding>>;
  readonly workdir: SlotBinding;
  readonly fan_out?: FanOutDefinition;
  readonly artifact_productions: readonly ArtifactCollectionDefinition[];
  readonly gates: readonly OutputGateDefinition[];
  readonly handoffs: readonly OutputHandoffDefinition[];
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
