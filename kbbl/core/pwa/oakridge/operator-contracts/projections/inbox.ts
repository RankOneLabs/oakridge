// Generated from oakridge-dbos/src/http/operator-api.ts. Run bun kbbl/scripts/generate-operator-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

import type { OperatorDecisionSubmit } from "./unit-view";

export type OperatorInboxItem =
  | { readonly kind: "decision"; readonly run_id: string; readonly unit_id: string; readonly key: string; readonly label: string;
    readonly submit: OperatorDecisionSubmit;
    /** The awaiting review's prompt, rendered with its resolved inputs; null for a retry. */
    readonly prompt: string | null }
  | { readonly kind: "waiting"; readonly run_id: string; readonly unit_id: string; readonly reason: string; readonly label: string }
  | { readonly kind: "stalled"; readonly run_id: string; readonly unit_id: string; readonly detail: string };

export interface OperatorInboxPage { readonly items: readonly OperatorInboxItem[]; readonly next_cursor: string | null }

export interface OperatorRunInboxBatch { readonly items: readonly OperatorRunInboxBatchEntry[] }

export interface OperatorRunInboxBatchEntry { readonly run_id: string; readonly items: readonly OperatorInboxItem[] }
