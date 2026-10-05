import type { CheckedValue, CommandDefinition, DefinitionBundle, DecisionOutcome } from "../core-client/generated-contracts";

export interface TargetRevision { readonly identity: string; readonly version: number }

export function availableCommand(definition: DefinitionBundle, scope_key: string, state: CheckedValue, command_key: string): CommandDefinition | null {
  const command = definition.scopes.find((scope) => scope.key === scope_key)?.commands.find((item) => item.key === command_key);
  if (!command) return null;
  const state_key = state.data.kind === "variant" ? state.data.variant : state.data.kind === "enum" ? state.data.variant : null;
  return command.available_in.length === 0 || (state_key !== null && command.available_in.includes(state_key)) ? command : null;
}

export function targetsMatch(command: CommandDefinition, outcome: DecisionOutcome, submitted: readonly TargetRevision[], current: readonly TargetRevision[]): boolean {
  return outcome.kind === "apply" && outcome.targets.length === command.targets.length && submitted.length === current.length
    && current.length === command.targets.length && current.every((target, index) => target.identity === submitted[index]?.identity && target.version === submitted[index]?.version);
}
