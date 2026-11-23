// Generated from oakridge-dbos/src/http/operator-api.ts. Run bun kbbl/scripts/generate-operator-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

export interface OperatorRecordedFeedbackDisposition {
  readonly decision_id: string;
  readonly kind: "proposal_rejected" | "follow_up_rejected" | "dispatched" | "approved";
  readonly item_id: string | null;
  readonly assignment_id: string | null;
  readonly round_id: string | null;
  readonly reason: string | null;
  readonly actor: string | null;
  readonly created_at: string;
}
