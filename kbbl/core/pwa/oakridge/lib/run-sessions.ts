import type { OperatorExecutionView, OperatorScopeView } from "../operator-contracts";

export interface RunExecution { readonly scope_id: string; readonly execution: OperatorExecutionView }
export const selectRunExecutions = (scopes: readonly OperatorScopeView[]): readonly RunExecution[] =>
  scopes.flatMap((scope) => scope.executions.map((execution) => ({ scope_id: scope.scope_id, execution })));
