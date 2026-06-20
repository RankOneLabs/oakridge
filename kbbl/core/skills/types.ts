import type { RuntimeId } from "../runtime";

export interface ArgSpec {
  key: string;
  required: boolean;
  hint: string;
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
