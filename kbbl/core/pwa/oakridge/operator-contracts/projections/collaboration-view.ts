// Generated from oakridge-dbos/src/http/operator-api.ts. Run bun kbbl/scripts/generate-operator-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

import type { OperatorCollaborationMessageRow, OperatorCollaborationThreadRow, OperatorReviewItemRow } from "../domain/delegated-session";

export interface OperatorCollaborationThreadView {
  readonly id: string;
  readonly run_id: string;
  readonly unit_id: string;
  readonly artifact_revision_id: string;
  readonly context: OperatorCollaborationThreadRow["context"];
  readonly created_at: string;
  readonly capabilities: { readonly can_write: boolean };
  readonly messages: readonly OperatorCollaborationMessageRow[];
  readonly review_items: readonly OperatorReviewItemRow[];
}
