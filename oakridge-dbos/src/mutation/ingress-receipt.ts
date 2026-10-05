import type { DecisionOutcome, Trigger } from "../core-client/generated-contracts";
import type { ScopeId } from "./scope-version";
export interface IngressIdentity { readonly scope_id: ScopeId; readonly ingress_id: string; readonly digest: string }
export interface CommittedResult { readonly kind: "committed"; readonly transition_id: string; readonly version: number }
export interface IngressReceipt extends IngressIdentity {
  readonly trigger: Trigger; readonly expected_version: number;
  readonly decision: DecisionOutcome | null; readonly result: CommittedResult | null;
}
export interface IngressConflict { readonly kind: "ingress_conflict"; readonly scope_id: ScopeId; readonly ingress_id: string }
export const isExactReplay = (receipt: IngressReceipt, identity: IngressIdentity): boolean =>
  receipt.scope_id === identity.scope_id && receipt.ingress_id === identity.ingress_id && receipt.digest === identity.digest;
