import type { OperatorCommandDescriptor, OperatorDraftKey, OperatorGenericRun, OperatorScopeView, OperatorTargetRevision } from "../operator-contracts";

/** Target identities must come from the observed projection, never a later fetch. */
export function selectCommandTargets(scope: OperatorScopeView, command: OperatorCommandDescriptor): readonly OperatorTargetRevision[] | null {
  const supplied = scope.command_targets?.[command.key];
  if (supplied) return supplied.length === command.targets.length ? supplied : null;
  if (command.targets.length === 0) return [];
  const selected: OperatorTargetRevision[] = [];
  for (const expression of command.targets) {
    if (!expression || typeof expression !== "object" || !("kind" in expression) || expression.kind !== "reference"
      || !("root" in expression) || !expression.root || typeof expression.root !== "object"
      || !("kind" in expression.root) || expression.root.kind !== "output"
      || !("key" in expression.root) || typeof expression.root.key !== "string") return null;
    const outputKey = expression.root.key;
    const slot = scope.outputs.find((item) => item.output_key === outputKey && item.collection_key === "");
    if (!slot?.current_revision_id) return null;
    selected.push({ identity: slot.current_revision_id, version: slot.version });
  }
  return selected;
}

export function selectDraftKey(scope: OperatorScopeView, command: OperatorCommandDescriptor): OperatorDraftKey | null {
  const targets = selectCommandTargets(scope, command);
  return targets === null ? null : { run_id: scope.run_id, scope_id: scope.scope_id,
    command_key: command.key, owner_version: scope.cursor.scope_version, targets };
}

export interface RootScopeInput { readonly scopes: OperatorGenericRun["scopes"]; readonly root_key: string }

/**
 * The server lists a run's scopes by random id, so position says nothing; the
 * pinned definition's `root` key names the root scope. Null when the run has
 * no scope under that key, rather than a guess at another one.
 */
export function selectRootScopeId({ scopes, root_key }: RootScopeInput): string | null {
  return scopes.find((scope) => scope.scope_key === root_key)?.scope_id ?? null;
}
