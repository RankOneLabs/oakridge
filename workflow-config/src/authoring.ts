/** Serializable operator choices recorded alongside a pinned definition. */
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
