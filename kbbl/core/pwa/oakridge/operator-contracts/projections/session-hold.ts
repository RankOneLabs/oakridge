// Generated from oakridge-dbos/src/http/operator-api.ts. Run bun kbbl/scripts/generate-operator-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

export interface OperatorSessionHold {
  readonly session_id: string;
  readonly run_id: string;
  readonly unit_id: string;
  readonly worker: string;
  /** The attempt's action id: the identity its own close carries. */
  readonly action_id: string;
}

export interface OperatorSessionHoldResponse { readonly hold: OperatorSessionHold | null; readonly location: OperatorSessionRunLocation | null }

export interface OperatorSessionRunLocation { readonly run_id: string; readonly unit_id: string }
