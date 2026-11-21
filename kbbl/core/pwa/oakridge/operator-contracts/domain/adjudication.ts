// Generated from oakridge-dbos/src/http/operator-api.ts. Run bun kbbl/scripts/generate-operator-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

import type { OperatorActionSource } from "./assessment";

export type OperatorDisposition = "accepted" | "modified" | "rejected";

export interface OperatorAdjudication {
  readonly entries: readonly OperatorProposedActionEntry[]; readonly added_actions: readonly OperatorAddedActionEntry[]; readonly rework_feedback: string;
}

export interface OperatorProposedActionEntry {
  readonly action_id: string; readonly disposition: OperatorDisposition; readonly original_text: string;
  readonly final_text?: string | null; readonly audience: "rework" | "operator"; readonly source: OperatorActionSource; readonly reason?: string | null;
}

export interface OperatorAddedActionEntry {
  readonly action_id: string; readonly origin: "operator"; readonly final_text: string;
  readonly audience: "rework" | "operator"; readonly source: OperatorActionSource; readonly reason?: string | null;
}
