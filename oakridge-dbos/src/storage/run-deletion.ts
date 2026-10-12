import type { RunId } from "../domain/primitives";
import { jsonText, type Database, type DatabaseTransaction } from "./database";
import { SETTLED_STATUSES } from "./executor-store";

export type DeleteEligibility = { readonly kind: "allowed" } | { readonly kind: "refused"; readonly obligations: number };
export type DeleteRunResult = DeleteEligibility | { readonly kind: "deleted" } | { readonly kind: "missing" };

/** An unsettled intent may own an external execution; a settled one (stopped or failed) is the only cleanup proof. */
export async function deletionEligibility(trx: DatabaseTransaction, run_id: RunId): Promise<DeleteEligibility> {
  const row = await trx.selectFrom("authority.effect_intent").select((eb) => eb.fn.countAll<number>().as("obligations"))
    .where("run_id", "=", run_id).where("status", "not in", SETTLED_STATUSES).executeTakeFirstOrThrow();
  return row.obligations === 0 ? { kind: "allowed" } : { kind: "refused", obligations: row.obligations };
}

/**
 * The one sanctioned delete of workflow-state rows. It holds the run row,
 * refuses while any intent is unsettled, and removes every row of the run,
 * children before parents. The operator stream keeps the run's events with no
 * run (D12) and announces the deletion.
 */
export async function deleteRun(db: Database, run_id: RunId): Promise<DeleteRunResult> {
  return db.transaction().execute(async (trx) => {
    const run = await trx.selectFrom("authority.run").select("id").where("id", "=", run_id).forUpdate().executeTakeFirst();
    if (!run) return { kind: "missing" };
    const eligibility = await deletionEligibility(trx, run_id);
    if (eligibility.kind === "refused") return eligibility;
    await trx.deleteFrom("authority.collaboration_delivery").where("run_id", "=", run_id).execute();
    await trx.deleteFrom("authority.review_item").where("run_id", "=", run_id).execute();
    await trx.deleteFrom("authority.collaboration_message").where("run_id", "=", run_id).execute();
    await trx.deleteFrom("authority.collaboration_thread").where("run_id", "=", run_id).execute();
    await trx.deleteFrom("authority.ingress_receipt").where("run_id", "=", run_id).execute();
    await trx.deleteFrom("authority.wanted_log").where("run_id", "=", run_id).execute();
    await trx.deleteFrom("authority.review_decision").where("run_id", "=", run_id).execute();
    await trx.deleteFrom("authority.effect_intent").where("run_id", "=", run_id).execute();
    await trx.deleteFrom("authority.capacity_reservation").where("run_id", "=", run_id).execute();
    await trx.deleteFrom("authority.capacity_pool").where("run_id", "=", run_id).execute();
    await trx.deleteFrom("authority.event").where("run_id", "=", run_id).execute();
    await trx.deleteFrom("authority.artifact_revision").where("run_id", "=", run_id).execute();
    await trx.deleteFrom("authority.attempt").where("run_id", "=", run_id).execute();
    await trx.deleteFrom("authority.unit_dependency").where("run_id", "=", run_id).execute();
    await trx.updateTable("authority.run").set({ root_unit_id: null }).where("id", "=", run_id).execute();
    await trx.deleteFrom("authority.unit").where("run_id", "=", run_id).execute();
    await trx.deleteFrom("authority.run").where("id", "=", run_id).execute();
    await trx.insertInto("authority.operator_event").values({ id: crypto.randomUUID(), run_id: null, run_key: run_id, event_key: "invalidate",
      payload: jsonText({ kind: "invalidate", data: { target: "run", run_id } }) }).execute();
    return { kind: "deleted" };
  });
}
