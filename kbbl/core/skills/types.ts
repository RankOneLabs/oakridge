import type { RuntimeId } from "../runtime";

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
  backend: RuntimeId;
  scope: "user" | "project" | "system" | "admin";
  args: ArgSpec[];
  user_invocable: boolean;
  model_invocable: boolean;
  confirm?: boolean;
}
