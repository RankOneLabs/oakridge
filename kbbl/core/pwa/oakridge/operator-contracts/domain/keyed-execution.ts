// Generated from oakridge-dbos/src/http/operator-api.ts. Run bun kbbl/scripts/generate-operator-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

export interface OperatorReconcileExecutionRequest {
  readonly request_id: string;
  readonly outcome: OperatorExecutionReconciliation;
}

export type OperatorExecutionReconciliation = { readonly kind: "evidence"; readonly evidence: OperatorExecutionEvidence }
  | { readonly kind: "never_accepted" };

export interface OperatorExecutionEvidence {
  readonly external_id: string;
  readonly store_path: string;
  readonly detail: string;
}
