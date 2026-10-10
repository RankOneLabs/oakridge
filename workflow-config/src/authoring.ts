/** Serializable operator choices for the development workflow template. */
export interface WorkflowAuthoring {
  readonly authoring_version: 1;
  readonly template: "development";
  readonly key: string;
  readonly implementation_capacity: number;
  readonly sibling_failure: "cancel" | "continue_independent";
  readonly wire_field_order: "canonical" | "alternate";
  readonly stage_layout: "standard" | "verification";
}

export interface AuthoringError {
  readonly kind: "authoring_error";
  readonly field_path: string;
  readonly detail: string;
}
