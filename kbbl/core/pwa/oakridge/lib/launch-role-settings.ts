import type { OperatorDefinitionBundle, OperatorRunConfig, OperatorSessionSettings } from "../operator-contracts";
import type { RoleSelection } from "./runtime-selection";

export interface RoleSelections { readonly planner: RoleSelection; readonly worker: RoleSelection }

/** The stages the planner settings drive; every other stage takes the worker settings. */
export const PLANNER_STAGES: ReadonlySet<string> = new Set(["analysis", "planning", "briefs"]);

/** The stages a definition's units run, each once. */
export const selectDefinitionStages = (bundle: OperatorDefinitionBundle | undefined): readonly string[] =>
  [...new Set((bundle?.units ?? []).flatMap((unit) => unit.stage === null ? [] : [unit.stage]))];

const sessionSettings = (selection: RoleSelection): OperatorSessionSettings =>
  ({ harness: selection.runtime, model: selection.model, effort: selection.effort ?? null });

/** The launch config: each stage's sessions start with its role's runtime, model and effort. */
export function selectRunConfig(stages: readonly string[], selections: RoleSelections): OperatorRunConfig {
  return { sessions: Object.fromEntries(stages.map((stage) =>
    [stage, sessionSettings(PLANNER_STAGES.has(stage) ? selections.planner : selections.worker)])) };
}
