import type { TransactionalSqlExecutor } from "./sql-executor";
import type { CoreClient } from "../core-client/client";
import { createMutationService } from "./mutation-service";
import type { RunId } from "./schema-records";
import { pendingCleanupCount, type DeleteEligibility } from "../effects/intents";

export interface CancelRunCommand { readonly kind: "cancel_run"; readonly run_id: string; readonly reason: string }
export type CancelRunResult = { readonly kind: "cancelled" } | { readonly kind: "missing" } | { readonly kind: "rejected"; readonly detail: string };

/**
 * v1 walked every scope and synthesised a per-scope cancellation trigger. v2
 * has one run-scoped `cancel_requested` event: the evaluator decides which
 * units stop, and the executor settles each effect intent's own row.
 */
export async function cancelRun(db: TransactionalSqlExecutor, command: CancelRunCommand, core?: CoreClient): Promise<CancelRunResult> {
  const runs = await db.query<{ id: string }>("SELECT id FROM authority.run WHERE id=$1", [command.run_id]);
  if (!runs.length) return { kind: "missing" };
  if (!core) return { kind: "rejected", detail: "cancellation requires the evaluator" };
  const mutations = createMutationService(db, core);
  const submitted = await mutations.submit({
    run_id: command.run_id as RunId, ingress_id: `cancel:${command.run_id}`,
    event: { kind: "cancel_requested" }, writer: { kind: "operator", subject: command.reason },
  });
  if (!submitted.ok) return { kind: "rejected", detail: submitted.error.detail };
  const result = submitted.value;
  if (result.kind === "committed" || result.kind === "replayed") return { kind: "cancelled" };
  return { kind: "rejected", detail: result.detail };
}

export type DeleteRunResult = DeleteEligibility | { readonly kind: "deleted" } | { readonly kind: "missing" };

/** Child-to-parent order, so every foreign key is satisfied as rows go. */
const RUN_SCOPED_TABLES = [
  "collaboration_delivery", "review_item", "collaboration_message", "collaboration_thread",
  "operator_event", "ingress_receipt", "effect_intent", "wanted_log", "event",
  "capacity_reservation", "capacity_pool", "review_decision", "artifact_revision",
  "unit_dependency",
] as const;

export async function deleteRun(db: TransactionalSqlExecutor, run_id: string): Promise<DeleteRunResult> {
  return db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [run_id]);
    const runs = await tx.query<{ id: string }>("SELECT id FROM authority.run WHERE id=$1 FOR UPDATE", [run_id]);
    if (!runs.length) return { kind: "missing" };
    const obligations = await pendingCleanupCount(tx, run_id);
    if (obligations) return { kind: "refused", obligations };
    for (const table of RUN_SCOPED_TABLES) await tx.query(`DELETE FROM authority.${table} WHERE run_id=$1`, [run_id]);
    await tx.query("DELETE FROM authority.attempt WHERE run_id=$1", [run_id]);
    // A unit's parent is another unit in the same run, so clear the links first.
    await tx.query("UPDATE authority.unit SET parent_id=NULL WHERE run_id=$1", [run_id]);
    await tx.query("UPDATE authority.run SET root_unit_id=NULL WHERE id=$1", [run_id]);
    await tx.query("DELETE FROM authority.unit WHERE run_id=$1", [run_id]);
    await tx.query("DELETE FROM authority.run WHERE id=$1", [run_id]);
    return { kind: "deleted" };
  });
}

interface RunGenerationRow { readonly current_generation: string | number; readonly current_cursor: string | null }
export interface RunAddress { readonly generation: number; readonly cursor: string | null }
export async function currentRunAddress(db: TransactionalSqlExecutor, run_id: string): Promise<RunAddress | null> {
  const rows = await db.query<RunGenerationRow>("SELECT current_generation,current_cursor FROM authority.run WHERE id=$1", [run_id]);
  return rows[0] ? { generation: Number(rows[0].current_generation), cursor: rows[0].current_cursor ?? null } : null;
}
/** The authority row is the address book for rollover and recovery. */
export async function currentRunGeneration(db: TransactionalSqlExecutor, run_id: string): Promise<number | null> {
  return (await currentRunAddress(db, run_id))?.generation ?? null;
}
/** Claim a successor only while the caller still owns the current generation. */
export async function claimRunGeneration(db: TransactionalSqlExecutor, run_id: string, expected: number, cursor?: string | null): Promise<number | null> {
  const rows = await db.query<RunGenerationRow>(`UPDATE authority.run SET current_generation=current_generation+1,
    current_cursor=CASE WHEN $3::boolean THEN $4 ELSE current_cursor END
    WHERE id=$1 AND current_generation=$2 RETURNING current_generation,current_cursor`, [run_id, expected, cursor !== undefined, cursor ?? null]);
  return rows[0] ? Number(rows[0].current_generation) : null;
}

/** A terminal root can still owe provider starts or cleanup. */
export const RUN_NEEDS_WORK_SQL = `EXISTS (
  SELECT 1 FROM authority.unit u
  WHERE u.run_id=r.id AND u.parent_id IS NULL AND u.status->>'kind' NOT IN ('done','cancelled')
) OR EXISTS (
  SELECT 1 FROM authority.effect_intent e
  WHERE e.run_id=r.id AND e.status NOT IN ('stopped','failed')
)`;
interface RunWorkRow { readonly has_work: boolean }
export async function runNeedsWork(db: TransactionalSqlExecutor, run_id: string): Promise<boolean> {
  const rows = await db.query<RunWorkRow>(`SELECT (${RUN_NEEDS_WORK_SQL}) AS has_work FROM authority.run r WHERE r.id=$1`, [run_id]);
  return rows[0]?.has_work ?? false;
}
