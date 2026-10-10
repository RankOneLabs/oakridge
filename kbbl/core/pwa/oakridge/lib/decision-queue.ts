import type { OperatorCommandDefinition, OperatorScopeView } from "../operator-contracts";
import { selectCommandTargets } from "./operator-selectors";

export const selectActionableScopes = (scopes: readonly OperatorScopeView[]): readonly OperatorScopeView[] =>
  scopes.filter((scope) => scope.commands.length > 0 && !scope.is_terminal);

export const selectArtifactCommands = (scope: OperatorScopeView, revisionId: string): readonly OperatorCommandDefinition[] =>
  scope.commands.filter((command) => selectCommandTargets(scope, command)?.some((target) => target.identity === revisionId));
