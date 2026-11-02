// Workflow-definition authoring forms.
export type SlotBindingSource =
  | "input"
  | "context"
  | "literal"
  | "item"
  | "context_lookup"
  | "input_lookup";

export type SlotBinding =
  | { from: "input"; input_name: string; path?: string | null }
  | { from: "context"; path: string }
  | { from: "literal"; value: string }
  | { from: "item"; path: string }
  | {
      from: "context_lookup";
      collection_path: string;
      collection_key_path: string;
      item_key_path: string;
      value_path: string;
    }
  // `context_lookup`'s sibling, keyed off a named input instead of the run
  // context. The seeded dev flow binds every cohort's expected PR base through
  // one of these; it was missing from this union, so the authoring UI could not
  // name the variant it was editing and replaced it on the first interaction.
  | {
      from: "input_lookup";
      input_name: string;
      collection_key_path: string;
      item_key_path: string;
      value_path: string;
    };

// Bindable: a bare string literal OR a SlotBinding.
export type Bindable = string | SlotBinding;

export interface WorktreeTemplate {
  branch_name: string;
  worktree_subdir: string;
  // A `Bindable`, not a string: the seeded dev flow resolves a cohort's base ref
  // through an `input_lookup` on the provisioned repository refs. Typed as a
  // string here, it rendered as `[object Object]` in a text input and became one
  // the moment anyone typed in it.
  base_ref?: Bindable | null;
}

// camelCase matches the executor's WorktreeIdentity wire contract.
export interface WorktreeIdentity {
  branchName: string;
  worktreeSubdir: string;
  baseRef?: string | null;
}

export interface FanOutConfig {
  over: SlotBinding;
  unit_id_path: string;
  depends_on_path?: string | null;
  max_parallel?: number;
  item_bindings?: Record<string, SlotBinding>;
  workdir?: SlotBinding | null;
  worktree?: WorktreeTemplate | null;
  inherit_worktree_from?: string | null;
}

export interface DelegatedSessionStageConfig {
  // Bindable like model/effort, but required: oakridge-dbos errors rather than
  // defaulting when a bound runtime resolves to nothing.
  runtime: Bindable;
  prompt_template_path: string;
  slot_bindings: Record<string, SlotBinding>;
  workdir: SlotBinding;
  session_name: string;
  model?: Bindable | null;
  effort?: Bindable | null;
  worktree?: WorktreeIdentity | null;
  pre_authorized_tools?: string[];
  yolo?: boolean;
  fan_out?: FanOutConfig | null;
  gate_output?: string | null;
}

export interface InputSlotDef {
  name: string;
  artifact_type: string;
  optional?: boolean;
  collect?: boolean;
  delivery?: "stage_complete" | "unit_complete";
}

export interface OutputSlotDef {
  name: string;
  artifact_type: string;
}

export interface StageNodeDef {
  stage_type: string;
  config: DelegatedSessionStageConfig;
  inputs: InputSlotDef[];
  outputs: OutputSlotDef[];
}

export interface EdgeEndpoint {
  stage: string;
  slot: string;
}

export interface EdgeDef {
  from: EdgeEndpoint;
  to: EdgeEndpoint;
}

export interface WorkflowGraph {
  stages: Record<string, StageNodeDef>;
  edges: EdgeDef[];
}

export interface WorkflowDefFull {
  id: string;
  name: string;
  version: number;
  graph: WorkflowGraph;
  created_at: string;
}

export interface WorkflowDefInput {
  name: string;
  version: number;
  graph: WorkflowGraph;
}
