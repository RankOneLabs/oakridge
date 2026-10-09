import { createHash, timingSafeEqual } from "node:crypto";
import type { Brand } from "../domain/primitives";
import type { RunId, ScopeId } from "../storage/schema-records";
import type { TransactionalSqlExecutor } from "../storage/sql-executor";

interface ExecutionSecretRow { readonly publication_secret_hash: string | null }
/** Proof the bearer holds the execution's minted secret; carries no liveness claim. */
export type VerifiedExecution = Brand<{ readonly execution_id: string; readonly scope_id: ScopeId; readonly run_id: RunId }, "VerifiedExecution">;

/** The secret check alone: no status filter, no selection join. A revoked or terminal execution still verifies. */
export async function verifyExecutionSecret(db: TransactionalSqlExecutor, run_id: RunId, scope_id: ScopeId, execution_id: string, header: string | undefined): Promise<VerifiedExecution | null> {
  const rows = await db.query<ExecutionSecretRow>("SELECT publication_secret_hash FROM authority.execution WHERE id=$1 AND scope_id=$2 AND run_id=$3", [execution_id, scope_id, run_id]);
  const expected = rows[0]?.publication_secret_hash;
  if (!expected || !header?.startsWith("Bearer ")) return null;
  const actual = createHash("sha256").update(header.slice(7)).digest("hex");
  if (!timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"))) return null;
  return { execution_id, scope_id, run_id } as VerifiedExecution;
}

/** The liveness check: still the current, pending generation for its worker. Call only once a receipt lookup has had its chance to replay. */
export async function requireCurrentAuthority(db: TransactionalSqlExecutor, verified: VerifiedExecution): Promise<boolean> {
  const rows = await db.query<{ execution_id: string }>(`SELECT x.execution_id FROM authority.execution e
    JOIN authority.execution_selection x ON x.scope_id=e.scope_id AND x.execution_id=e.id AND x.generation=e.generation
    WHERE e.id=$1 AND e.scope_id=$2 AND e.run_id=$3 AND e.status='pending'`, [verified.execution_id, verified.scope_id, verified.run_id]);
  return rows.length > 0;
}
