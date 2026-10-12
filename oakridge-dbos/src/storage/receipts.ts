import { createHash } from "node:crypto";
import type { CommitReceipt, RunId } from "./schema-records";
import type { SqlExecutor } from "./sql-executor";

export interface IngressIdentity { readonly run_id: RunId; readonly unit_id: string | null; readonly ingress_id: string; readonly request_digest: string }
export type ReceiptLookup = { readonly kind: "new" } | { readonly kind: "replay"; readonly receipt: CommitReceipt } | { readonly kind: "conflict" };
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export function requestDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
export async function findReceipt(tx: SqlExecutor, identity: IngressIdentity): Promise<ReceiptLookup> {
  const rows = await tx.query<{ request_digest: string; result: CommitReceipt }>(
    "SELECT request_digest,result FROM authority.ingress_receipt WHERE run_id=$1 AND ingress_id=$2", [identity.run_id, identity.ingress_id]);
  const found = rows[0];
  if (!found) return { kind: "new" };
  if (found.request_digest !== identity.request_digest) return { kind: "conflict" };
  return { kind: "replay", receipt: found.result };
}
