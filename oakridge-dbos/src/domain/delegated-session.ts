import type { JsonValue } from "./primitives";
import type { StageOperatorRole } from "./workflow";

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
  readonly worktree?: WorktreeTemplate;
  readonly inherit_worktree_from?: string;
}

export interface ArtifactCollectionDefinition { readonly over: SlotBinding; readonly id_path: string }
export interface OutputGateStep { readonly type: "artifact_approval" | "merge_confirmation"; readonly actions: readonly string[] }
export interface OutputGateDefinition {
  readonly output: string;
  readonly steps: readonly OutputGateStep[];
  readonly requires_zero_open_review_items?: boolean;
  readonly revision_target?: "self_stage" | "upstream_handoff";
}
export interface OutputHandoffDefinition {
  readonly output: string;
  readonly downstream_role: StageOperatorRole;
  readonly approved_wait: { readonly kind: string };
}

/** Exact definition-time JSON contract retained from Rust v2. */
export interface DelegatedSessionDefinitionConfig {
  readonly runtime: Bindable;
  readonly prompt_template_path: string;
  readonly slot_bindings: Readonly<Record<string, SlotBinding>>;
  readonly workdir: SlotBinding;
  readonly session_name: string;
  readonly model?: Bindable;
  readonly effort?: Bindable;
  readonly worktree?: WorktreeIdentity;
  readonly pre_authorized_tools?: readonly string[];
  readonly yolo?: boolean;
  readonly fan_out?: FanOutDefinition;
  readonly artifacts?: ArtifactCollectionDefinition;
  readonly gate_output?: string;
  readonly output_gate?: OutputGateDefinition;
  readonly output_handoff?: OutputHandoffDefinition;
}

export interface ResolvedExecutorConfig {
  readonly executor_type: "delegated_session";
  readonly runtime: "claude-code" | "codex";
  readonly rendered_prompt: string;
  readonly workdir: string;
  readonly session_name: string;
  readonly model: string | null;
  readonly effort: string | null;
  readonly worktree?: WorktreeIdentity;
  readonly executor_options: JsonValue;
}
