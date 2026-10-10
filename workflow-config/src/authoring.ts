/** Serializable operator choices for the development workflow template. */
export interface WorkflowAuthoring {
  readonly authoring_version: 1;
  readonly template: "development";
  readonly key: string;
  readonly implementation_capacity: number;
  readonly sibling_failure: "cancel" | "continue_independent";
  readonly wire_field_order: "canonical" | "alternate";
  readonly stage_layout: "standard" | "verification";
  readonly prompt_bindings?: readonly PromptBinding[];
}

export interface PromptBinding {
  readonly stage_key: string;
  readonly worker_key: string;
  readonly action_key: string;
  readonly prompt_key: string;
}

export interface AuthoringError {
  readonly kind: "authoring_error";
  readonly field_path: string;
  readonly detail: string;
}

/** Fixed roles of the task stage template. Cross-stage joins live in the template. */
export const TASK_STAGE_SLOTS = [
  { role: "config", schema: "session_config" },
  { role: "spec", schema: "text" },
  { role: "repositories", schema: "repository_configs" },
  { role: "repository_refs", schema: "repository_refs" },
  { role: "analysis", schema: "optional_analysis" },
  { role: "plan", schema: "optional_plan" },
  { role: "admission", schema: "admission_flags" },
] as const;

export const REPOSITORY_PREPARATION_STAGE_SLOTS = [
  { role: "repository_path", schema: "repo_path" },
  { role: "expected_head", schema: "optional_text" },
] as const;

export const IMPLEMENTATION_STAGE_SLOTS = [
  { role: "brief", schema: "brief_body" },
  { role: "repository", schema: "repository_config" },
  { role: "push_remote_owner", schema: "ident" },
  { role: "admission", schema: "admission_flags" },
] as const;

export const INTEGRATION_STAGE_SLOTS = [
  { role: "repository_key", schema: "ident" },
  { role: "config", schema: "session_config" },
  { role: "completed_work", schema: "completed_works" },
  { role: "forge", schema: "forge_config" },
  { role: "push_remote_owner", schema: "ident" },
  { role: "admission", schema: "admission_flags" },
  { role: "final_merge_policy", schema: "final_merge_policy" },
] as const;

export const ACTION_TEMPLATE_SLOTS = [
  { role: "selector", schema: "session_selector" },
  { role: "config", schema: "session_config" },
  { role: "context", schema: "session_context" },
] as const;

export const OBSERVER_TEMPLATE_SLOTS = [{ role: "query", schema: "pr_query" }] as const;
