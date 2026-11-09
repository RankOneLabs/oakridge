// Generated from observation/src/http/grading-api.ts. Run bun kbbl/scripts/generate-grading-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

export interface ObservationRunConfigWire {
  readonly sessions: { readonly [stage: string]: { readonly [worker: string]: ObservationSessionSettingsWire } };
  readonly grading_enabled: boolean;
}

export interface ObservationSessionSettingsWire { readonly harness: string; readonly model: string; readonly effort: string | null }
