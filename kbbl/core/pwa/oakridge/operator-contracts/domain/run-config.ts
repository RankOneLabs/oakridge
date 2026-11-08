// Generated from oakridge-dbos/src/http/operator-api.ts. Run bun kbbl/scripts/generate-operator-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

export interface OperatorRunConfig {
  readonly sessions: { readonly [stage: string]: { readonly [worker: string]: OperatorSessionSettings } };
  /** Whether observation may send this run's items to the configured graders. Off unless chosen. */
  readonly grading_enabled: boolean;
}

export interface OperatorSessionSettings { readonly harness: string; readonly model: string; readonly effort: string | null }
