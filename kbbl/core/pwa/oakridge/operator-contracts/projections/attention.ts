// Generated from oakridge-dbos/src/http/operator-api.ts. Run bun kbbl/scripts/generate-operator-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

import type { OperatorEvent } from "../core-client/core-types";

export interface OperatorRunStall {
  readonly kind: "stalled" | "faulted";
  /** Where advancing stopped; for a fault, the unit its event addressed (the root for a launch or a cancel). */
  readonly unit_id: string;
  readonly reason: string;
  /** The event it refused or faulted on. */
  readonly event: OperatorEvent;
  readonly ingress_id: string | null;
  /** When it was refused or recorded (ISO-8601). */
  readonly at: string;
}

export type OperatorAttention = { readonly kind: "waiting"; readonly reason: string } | { readonly kind: "stalled"; readonly detail: string };
