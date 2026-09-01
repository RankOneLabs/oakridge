export interface ArgSpec {
  key: string;
  required: boolean;
  hint: string;
  /** Input/coercion kind. Omitted for legacy skill arguments, which are text. */
  kind?: "string" | "integer" | "boolean";
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  /** Agent profile id this skill is offered for (e.g. "claude-code"). */
  backend: string;
  scope: "user" | "project" | "system" | "admin";
  args: ArgSpec[];
  user_invocable: boolean;
  model_invocable: boolean;
  confirm?: boolean;
}
