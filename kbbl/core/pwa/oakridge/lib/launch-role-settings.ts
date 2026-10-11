import type { RuntimeModelSelection } from "../../types";
import type { OperatorDefinitionBundle, OperatorSessionSettings } from "../operator-contracts";

export interface RoleSelections {
  readonly planner: RuntimeModelSelection;
  readonly worker: RuntimeModelSelection;
}

const isRecord = (value: unknown): value is { readonly [key: string]: unknown } =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** A bundle opts into the shared planner/worker controls through its pinned root schema. */
export function supportsRoleSessionInput(bundle: OperatorDefinitionBundle | undefined): boolean {
  if (!bundle || !Array.isArray(bundle.scopes) || !Array.isArray(bundle.schemas)) return false;
  const root = bundle.scopes.find((scope) => scope.key === bundle.root);
  const rootShape = bundle.schemas.find((schema) => schema.key === root?.input_schema)?.shape;
  if (rootShape?.kind !== "record") return false;
  const sessionsField = rootShape.fields.find((field) => field.key === "sessions");
  const sessionsShape = bundle.schemas.find((schema) => schema.key === sessionsField?.schema)?.shape;
  return sessionsShape?.kind === "record" && ["planner", "worker"].every((key) =>
    sessionsShape.fields.some((field) => field.key === key && field.schema === "session_settings"));
}

function sessionSettings(selection: RuntimeModelSelection): OperatorSessionSettings {
  return { runtime: selection.runtime, model: selection.model, effort: selection.effort ?? null };
}

/** Preserve any stage-specific settings while setting the two launch-wide roles. */
export function withRoleSessionInput(input: unknown, selections: RoleSelections): unknown {
  if (!isRecord(input)) return input;
  const sessions = isRecord(input.sessions) ? input.sessions : {};
  return { ...input, sessions: { ...sessions,
    planner: sessionSettings(selections.planner), worker: sessionSettings(selections.worker) } };
}
