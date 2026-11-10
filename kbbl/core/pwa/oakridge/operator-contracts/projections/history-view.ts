// Generated from oakridge-dbos/src/http/operator-api.ts. Run bun kbbl/scripts/generate-operator-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

import type { OperatorEvent, OperatorWriter } from "../core-client/core-types";
import type { OperatorAttemptView } from "./unit-view";
import type { OperatorAuthorityEffectStatus } from "../storage/db-types";

export interface OperatorUnitHistory { readonly unit_id: string; readonly events: readonly OperatorEventHistory[]; readonly next_cursor: string | null }

export interface OperatorUnitDiagnostics {
  readonly unit_id: string;
  readonly attempts: readonly OperatorAttemptView[];
  readonly effects: readonly OperatorEffectDiagnostic[];
  /** Events step refused for this unit. */
  readonly rejected: readonly OperatorRejectedEvent[];
}

export interface OperatorEventHistory {
  readonly id: string;
  /** The ingress id the event was committed under; null for an event with none. */
  readonly ingress_id: string | null;
  readonly event: OperatorEvent;
  readonly writer: OperatorWriter;
  readonly created_at: string;
}

export interface OperatorEffectDiagnostic {
  readonly id: string;
  readonly action_id: string;
  readonly seq: number;
  readonly status: OperatorAuthorityEffectStatus;
  readonly tries: number;
  readonly next_try_at: string | null;
  readonly last_error: string | null;
  readonly updated_at: string;
}

export interface OperatorRejectedEvent { readonly ingress_id: string; readonly reason: string }
