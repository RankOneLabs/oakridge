import type { RuntimeModelSelection } from "../../types";
import type { CreateRunContext, LaunchSessionSettings } from "../types";
import type { ModelRole } from "./runtime-selection";
import type { Result } from "../../lib/result";

/** One agent worker declared by the pinned v2 workflow. A collection may start
 * several sessions from this declaration; each inherits this run-level choice. */
export interface AgentSessionTarget {
  readonly key: string;
  readonly stage: string;
  readonly worker: string;
  readonly label: string;
  readonly suggested_role: ModelRole;
}

/** Worker declarations in GET /api/definitions/:id's authored workflow.
 * A template use has no local kind; its kind comes from workflow.workers. */
interface AgentWorkerDeclaration {
  readonly kind?: string | null;
  readonly template?: string;
}
export interface AgentWorkerWorkflow {
  readonly workflow: string;
  readonly workers?: Readonly<{ [template: string]: AgentWorkerDeclaration }>;
  readonly stages: Readonly<{ [stage: string]: { readonly workers: Readonly<{ [worker: string]: AgentWorkerDeclaration }> } }>;
}

const DEVELOPMENT_STAGE_ORDER = ["analysis", "planning", "brief", "cohort", "integration"] as const;
const developmentOrder = (stage: string): number => {
  const index = DEVELOPMENT_STAGE_ORDER.findIndex((candidate) => candidate === stage);
  return index < 0 ? DEVELOPMENT_STAGE_ORDER.length : index;
};

const suggestedRole = (workflow: string, stage: string, worker: string): ModelRole =>
  workflow === "development" && (["analysis", "planning", "brief", "integration"].includes(stage) || (stage === "cohort" && worker === "assessor"))
    ? "planner" : "worker";

/** The workflow definition, rather than a hard-coded cohort list, determines
 * which sessions the launch form can configure. Code workers have no model. */
export function selectAgentSessionTargets(workflow: AgentWorkerWorkflow): readonly AgentSessionTarget[] {
  const targets = Object.entries(workflow.stages).flatMap(([stage, definition]) =>
    Object.entries(definition.workers).filter(([, declaration]) =>
      (declaration.template ? workflow.workers?.[declaration.template]?.kind : declaration.kind) === "agent")
      .map(([worker]) => ({
      key: JSON.stringify([stage, worker]), stage, worker, label: `${stage} · ${worker}`,
      suggested_role: suggestedRole(workflow.workflow, stage, worker),
    })));
  return targets.sort((left, right) => developmentOrder(left.stage) - developmentOrder(right.stage)
    || (left.stage === "cohort" ? (left.worker === "builder" ? -1 : right.worker === "builder" ? 1 : 0) : 0)
    || left.key.localeCompare(right.key));
}

export type SessionSelectionMap = Readonly<{ [key: string]: RuntimeModelSelection }>;
export interface SessionSettingsSelectionError {
  readonly operation: "select_session_settings";
  readonly detail: string;
}

/** Make a complete, exact config from the definition's agent workers. */
export function selectLaunchSessionSettings(targets: readonly AgentSessionTarget[], selections: SessionSelectionMap):
  Result<CreateRunContext["session_settings"], SessionSettingsSelectionError> {
  const settings = new Map<string, Map<string, LaunchSessionSettings>>();
  for (const target of targets) {
    const selection = selections[target.key];
    if (!selection?.runtime || !selection.model.trim())
      return { ok: false, error: { operation: "select_session_settings", detail: `Choose a runtime and model for ${target.label}.` } };
    const workers = settings.get(target.stage) ?? new Map<string, LaunchSessionSettings>();
    workers.set(target.worker, { harness: selection.runtime, model: selection.model, effort: selection.effort ?? null });
    settings.set(target.stage, workers);
  }
  if (settings.size === 0)
    return { ok: false, error: { operation: "select_session_settings", detail: "The selected workflow has no agent sessions." } };
  return { ok: true, value: Object.fromEntries([...settings].map(([stage, workers]) => [stage, Object.fromEntries(workers)])) };
}
