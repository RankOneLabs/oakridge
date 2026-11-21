// Generated from oakridge-dbos/src/http/operator-api.ts. Run bun kbbl/scripts/generate-operator-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

import type { OperatorWriter } from "../core-client/core-types";
import type { OperatorDisposition } from "../domain/adjudication";
import type { OperatorActionSource } from "../domain/assessment";

export type OperatorActionHistoryEntry =
  | (OperatorActionHistoryContext & {
    readonly kind: "assessed";
    readonly action_id: string;
    readonly disposition: OperatorDisposition;
    readonly original_text: string;
    readonly final_text: string | null;
    readonly source: OperatorActionSource;
    readonly reason: string | null;
  })
  | (OperatorActionHistoryContext & {
    readonly kind: "added";
    readonly action_id: string;
    readonly final_text: string;
    readonly source: OperatorActionSource;
    readonly reason: string | null;
  });

export interface OperatorActionHistoryContext {
  readonly unit_id: string;
  readonly assessment_revision_id: string;
  readonly review: string;
  readonly decision: string;
  readonly decision_id: string;
  readonly actor: OperatorWriter | null;
  readonly created_at: string;
}
