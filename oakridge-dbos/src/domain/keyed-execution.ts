export interface ExecutionEvidence {
  readonly external_id: string;
  readonly store_path: string;
  readonly detail: string;
}
export type KeyedExecutionRecovery = "off" | "by_key";
export type ExecutionState = "unclaimed" | "claimed" | "evidence_attached" | "reconcile";
export type ClaimAnswer = { readonly kind: "launch" } | { readonly kind: "resume"; readonly evidence: ExecutionEvidence }
  | { readonly kind: "recover" } | { readonly kind: "reconcile_required" };
export type ExecutionReconciliation = { readonly kind: "evidence"; readonly evidence: ExecutionEvidence }
  | { readonly kind: "never_accepted" };
export interface ReconcileExecutionRequest {
  readonly request_id: string;
  readonly outcome: ExecutionReconciliation;
}
interface ClaimRecord { readonly state: ExecutionState; readonly evidence: ExecutionEvidence | null }
interface ClaimTransition { readonly answer: ClaimAnswer; readonly next_state: ExecutionState }

export function selectClaimAnswer(record: ClaimRecord, recovery: KeyedExecutionRecovery): ClaimTransition {
  switch (record.state) {
    case "unclaimed": return { answer: { kind: "launch" }, next_state: "claimed" };
    case "evidence_attached":
      if (record.evidence) return { answer: { kind: "resume", evidence: record.evidence }, next_state: "evidence_attached" };
      break;
    case "claimed":
      if (recovery === "by_key") return { answer: { kind: "recover" }, next_state: "claimed" };
      break;
    case "reconcile": break;
  }
  return { answer: { kind: "reconcile_required" }, next_state: "reconcile" };
}

export function parseExecutionEvidence(value: unknown): ExecutionEvidence | null {
  if (!value || typeof value !== "object" || !("external_id" in value) || !("store_path" in value)
      || !("detail" in value) || typeof value.external_id !== "string" || !value.external_id.trim()
      || typeof value.store_path !== "string" || !value.store_path.trim() || typeof value.detail !== "string") return null;
  return { external_id: value.external_id, store_path: value.store_path, detail: value.detail };
}
