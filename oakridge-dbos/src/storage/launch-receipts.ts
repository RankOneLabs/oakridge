import type { RunId, ScopeId } from "./schema-records";
import type { SqlExecutor } from "./sql-executor";
import type { StartedRun } from "./mutation-service";

/** Mirrors authority.launch_receipt; a null run_id is a retained deletion tombstone. */
export interface LaunchReceiptRecord {
  readonly request_id: string; readonly request_digest: string;
  readonly run_id: RunId | null; readonly root_scope_id: ScopeId; readonly bundle_id: string;
}
export type LaunchReceiptLookup = { readonly kind: "new" } | { readonly kind: "conflict" }
  | { readonly kind: "gone" } | { readonly kind: "replay"; readonly run: StartedRun };
export async function findLaunchReceipt(db: SqlExecutor, request_id: string, request_digest: string): Promise<LaunchReceiptLookup> {
  const receipt = (await db.query<LaunchReceiptRecord>("SELECT * FROM authority.launch_receipt WHERE request_id=$1", [request_id]))[0];
  if (!receipt) return { kind: "new" };
  if (receipt.request_digest !== request_digest) return { kind: "conflict" };
  if (receipt.run_id === null) return { kind: "gone" };
  return { kind: "replay", run: { run_id: receipt.run_id, root_scope_id: receipt.root_scope_id, bundle_id: receipt.bundle_id } };
}
