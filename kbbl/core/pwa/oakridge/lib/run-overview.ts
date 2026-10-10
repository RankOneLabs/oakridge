import type { OperatorArtifactRevisionRecord, OperatorOutputSlotView, OperatorRunView, OperatorScopeView } from "../operator-contracts";

export interface RunProgress { readonly complete: number; readonly total: number; readonly needs_attention: number }
export interface RunArtifact { readonly scope_id: string; readonly output: OperatorOutputSlotView; readonly revision: OperatorArtifactRevisionRecord }

export const selectRunProgress = (run: OperatorRunView): RunProgress => ({
  complete: run.scopes.filter((scope) => scope.is_terminal).length,
  total: run.scopes.length,
  needs_attention: run.scopes.filter((scope) => !scope.is_terminal && scope.available_commands.length > 0).length,
});

export const selectRunScope = (run: OperatorRunView, scopeId: string | null, rootKey: string | null): OperatorRunView["scopes"][number] | null =>
  run.scopes.find((scope) => scope.scope_id === scopeId)
    ?? run.scopes.find((scope) => scope.scope_key === rootKey)
    ?? run.scopes[0] ?? null;

export const selectRunArtifacts = (scopes: readonly OperatorScopeView[]): readonly RunArtifact[] =>
  scopes.flatMap((scope) => scope.outputs.flatMap((output) => output.current_revision
    ? [{ scope_id: scope.scope_id, output, revision: output.current_revision }] : []));

export const selectLoadedScopes = (values: readonly (OperatorScopeView | undefined)[]): readonly OperatorScopeView[] =>
  values.filter((value): value is OperatorScopeView => value !== undefined);

export const selectScopeDetail = (scopes: readonly OperatorScopeView[], scopeId: string | null): OperatorScopeView | null =>
  scopeId === null ? scopes[0] ?? null : scopes.find((scope) => scope.scope_id === scopeId) ?? null;

export const selectScopeQueryIndex = (run: OperatorRunView, scopeId: string | null): number =>
  run.scopes.findIndex((scope) => scope.scope_id === scopeId);

export const selectWaitingScopes = (scopes: readonly OperatorScopeView[]): readonly OperatorScopeView[] =>
  scopes.filter((scope) => scope.decision?.kind === "wait");

export const selectCompletedScopeDetails = (scopes: readonly OperatorScopeView[]): readonly OperatorScopeView[] =>
  scopes.filter((scope) => scope.outcome !== null);

export const selectFinalIntegrationScope = (scopes: readonly OperatorScopeView[]): OperatorScopeView | null =>
  scopes.find((scope) => scope.scope_key === "final_integration") ?? null;

export const selectArtifactInScopes = (scopes: readonly OperatorScopeView[], revisionId: string): RunArtifact | null =>
  selectRunArtifacts(scopes).find((artifact) => artifact.revision.id === revisionId) ?? null;

export const selectScopeStatus = (scope: OperatorRunView["scopes"][number]): "complete" | "attention" | "running" =>
  scope.is_terminal ? "complete" : scope.available_commands.length > 0 ? "attention" : "running";
