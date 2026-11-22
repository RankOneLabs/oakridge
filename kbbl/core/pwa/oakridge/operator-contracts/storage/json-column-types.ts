// Generated from oakridge-dbos/src/http/operator-api.ts. Run bun kbbl/scripts/generate-operator-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

export interface OperatorForgeRepository { readonly provider: "github"; readonly owner: string; readonly name: string }

export interface OperatorAssessmentDecisionReceipt {
  readonly decision_id: string;
  readonly approval_id: string | null;
  readonly rejection_ids: readonly string[];
  readonly round_ids: readonly string[];
}

export interface OperatorCollaborationThreadContext { readonly title: string; readonly anchor: string | null }

export interface OperatorCollaborationMessageBody { readonly text: string; readonly author: string }

export interface OperatorReviewItemBody { readonly title: string; readonly detail: string; readonly status: string }
