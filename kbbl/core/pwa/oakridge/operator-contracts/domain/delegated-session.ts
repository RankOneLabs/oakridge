// Generated from oakridge-dbos/src/http/operator-api.ts. Run bun kbbl/scripts/generate-operator-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

import type { OperatorCollaborationMessageBody, OperatorCollaborationThreadContext, OperatorReviewItemBody } from "../storage/json-column-types";

export interface OperatorCollaborationThreadRow {
  readonly id: string; readonly run_id: string; readonly unit_id: string;
  readonly artifact_revision_id: string; readonly context: OperatorCollaborationThreadContext;
  readonly created_at: string;
}

export interface OperatorCollaborationMessageRow {
  readonly id: string; readonly run_id: string; readonly unit_id: string;
  readonly thread_id: string; readonly body: OperatorCollaborationMessageBody; readonly created_at: string;
}

export interface OperatorReviewItemRow {
  readonly id: string; readonly run_id: string; readonly unit_id: string;
  readonly thread_id: string; readonly artifact_revision_id: string;
  readonly body: OperatorReviewItemBody; readonly created_at: string;
}
