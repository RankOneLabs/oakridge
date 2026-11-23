import type { RuntimeModelSelection } from "../../types";
import type { CreateRunContext, LaunchSessionSettings } from "../project-types";
import type { ModelRole } from "./runtime-selection";
import type { OperatorDefinitionGraph } from "../operator-contracts/projections/definition-view";
import type { Result } from "../../lib/result";

/** Anything the launch form offers one runtime/model picker for. */
export interface ModelChoiceTarget {
  readonly key: string;
  readonly label: string;
  readonly suggested_role: ModelRole;
}

/** One agent worker declared by the pinned v2 workflow. A collection may start
 * several sessions from this declaration; each inherits this run-level choice. */
export interface AgentSessionTarget extends ModelChoiceTarget {
  readonly stage: string;
  readonly worker: string;
}

/** A planner or worker picker that sets every session of its role. */
export interface RoleChoiceTarget extends ModelChoiceTarget {
  /** The session labels this role's choice applies to. */
  readonly covers: readonly string[];
}

/** By role asks for two models; by session asks for one per agent session. */
export type SessionModelMode = "by_role" | "by_session";

/** Worker declarations in GET /api/definitions/:id's authored workflow.
 * A template use has no local kind; its kind comes from workflow.workers. */
interface AgentWorkerDeclaration {
  readonly kind?: string | null;
  readonly template?: string;
  readonly label?: string | null;
  readonly overrides?: { readonly label?: string | null } | null;
}
export interface AgentWorkerWorkflow {
  readonly workflow: string;
  readonly workers?: Readonly<{ [template: string]: AgentWorkerDeclaration }>;
  readonly stages: Readonly<{ [stage: string]: { readonly workers: Readonly<{ [worker: string]: AgentWorkerDeclaration }> } }>;
}

const suggestedRole = (workflow: string, stage: string, worker: string): ModelRole =>
  workflow === "development" && (["analysis", "planning", "brief", "integration"].includes(stage) || (stage === "cohort" && worker === "assessor"))
    ? "planner" : "worker";

function stageLevels(graph: OperatorDefinitionGraph): ReadonlyMap<string, number> {
  const levels = new Map<string, number>();
  const nodes = new Map(graph.nodes.map((node) => [node.key, node]));
  const visiting = new Set<string>();
  const level = (key: string): number => {
    const cached = levels.get(key);
    if (cached !== undefined) return cached;
    const node = nodes.get(key);
    if (!node || visiting.has(key)) return -1;
    visiting.add(key);
    const depth = Math.max(-1, ...node.depends_on.map(level)) + 1;
    visiting.delete(key);
    levels.set(key, depth);
    return depth;
  };
  const stages = new Map<string, number>();
  for (const node of graph.nodes) stages.set(node.stage, Math.min(stages.get(node.stage) ?? Infinity, level(node.key)));
  return stages;
}

export function selectAgentSessionTargets(workflow: AgentWorkerWorkflow, graph?: OperatorDefinitionGraph, workerNames?: Readonly<Record<string, readonly string[]>>): readonly AgentSessionTarget[] {
  const levels = graph ? stageLevels(graph) : new Map<string, number>();
  return Object.entries(workflow.stages)
    .sort(([left], [right]) => (levels.get(left) ?? Infinity) - (levels.get(right) ?? Infinity))
    .flatMap(([stage, definition]) => (workerNames?.[stage] ?? Object.keys(definition.workers)).flatMap((worker): AgentSessionTarget[] => {
      const declaration = definition.workers[worker];
      if (!declaration) return [];
      const template = declaration.template ? workflow.workers?.[declaration.template] : undefined;
      if ((template?.kind ?? declaration.kind) !== "agent") return [];
      const label = declaration.overrides?.label ?? declaration.label ?? template?.label ?? worker;
      return [{ key: JSON.stringify([stage, worker]), stage, worker, label: `${stage} · ${label}`, suggested_role: suggestedRole(workflow.workflow, stage, worker) }];
    }));
}

export type SessionSelectionMap = Readonly<{ [key: string]: RuntimeModelSelection }>;

const ROLE_LABELS: Readonly<{ [role in ModelRole]: string }> = { planner: "Planner", worker: "Worker" };

/** The role pickers by-role mode shows: one per role that has at least one session. */
export function selectRoleChoiceTargets(targets: readonly AgentSessionTarget[]): readonly RoleChoiceTarget[] {
  return (["planner", "worker"] as const)
    .map((role) => ({ key: role, label: ROLE_LABELS[role], suggested_role: role,
      covers: targets.filter((target) => target.suggested_role === role).map((target) => target.label) }))
    .filter((target) => target.covers.length > 0);
}

/** Expand role choices into one choice per session, keyed like by-session mode. */
export function selectSessionSelectionsFromRoles(targets: readonly AgentSessionTarget[], roles: SessionSelectionMap): SessionSelectionMap {
  return Object.fromEntries(targets.flatMap((target) => {
    const selection = roles[target.suggested_role];
    return selection ? [[target.key, selection] as const] : [];
  }));
}

/** The sessions whose role had its runtime chosen explicitly. */
export function selectSessionKeysFromRoleKeys(targets: readonly AgentSessionTarget[], role_keys: ReadonlySet<string>): ReadonlySet<string> {
  return new Set(targets.filter((target) => role_keys.has(target.suggested_role)).map((target) => target.key));
}
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
  return { ok: true, value: Object.fromEntries([...settings].map(([stage, workers]) => [stage, Object.fromEntries(workers)])) };
}
