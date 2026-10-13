import type { Kysely } from "kysely";
import type { DB } from "./db-types";
import type { Database, DatabaseTransaction } from "./database";
import type { AttemptRecord, EffectIntentRecord, EffectStatus } from "./schema-records";

type Reader = Kysely<DB> | DatabaseTransaction;

/**
 * effect_intent bookkeeping, and nothing else (rescue spec §2.2). Commit
 * inserts an intent as `pending` and requests its stop; the executor moves it
 * through `acknowledged` to `stopped` or `failed`, or requests its stop itself
 * when an attempt fails with an execution still possibly live, and keeps its start tries,
 * retry time and last error here. What a worker did is never written here: it
 * goes to commit as WorkerStarted, WorkerEnded and RevisionPublished.
 */
export type { EffectStatus } from "./schema-records";
export type EffectIntent = EffectIntentRecord;
/** The terminal statuses: the intent owns no external execution. */
export const SETTLED_STATUSES = ["stopped", "failed"] as const satisfies readonly EffectStatus[];
export type SettledStatus = typeof SETTLED_STATUSES[number];

export async function readIntent(db: Reader, intent_id: string): Promise<EffectIntent | null> {
  return (await db.selectFrom("authority.effect_intent").selectAll().where("id", "=", intent_id).executeTakeFirst() ?? null) as EffectIntent | null;
}

export interface OwedIntent { readonly id: string; readonly status: EffectStatus }
/** Intents a run still owes the outside world: starts to carry and stops to confirm. */
export async function listOwedIntents(db: Reader, run_id: string): Promise<readonly OwedIntent[]> {
  return db.selectFrom("authority.effect_intent").select(["id", "status"]).where("run_id", "=", run_id)
    .where("status", "in", ["pending", "acknowledged", "stop_requested"]).orderBy("id").execute();
}

/** Per-run work holds the run row; this is the one serialization mechanism for a run. */
async function lockRunOf(trx: DatabaseTransaction, intent_id: string): Promise<boolean> {
  const owner = await trx.selectFrom("authority.effect_intent").select("run_id").where("id", "=", intent_id).executeTakeFirst();
  if (!owner) return false;
  await trx.selectFrom("authority.run").select("id").where("id", "=", owner.run_id).forUpdate().execute();
  return true;
}

export type StartClaim = { readonly kind: "claimed"; readonly tries: number } | { readonly kind: "exhausted"; readonly tries: number }
  | { readonly kind: "not_pending"; readonly status: EffectStatus } | { readonly kind: "missing" };
/**
 * Reserve one provider start before calling the provider. A re-execution
 * before its outcome is recorded claims another try rather than replaying the
 * first, so a crash can never exceed the budget silently.
 */
export async function claimStart(db: Database, input: { readonly intent_id: string; readonly max_tries: number }): Promise<StartClaim> {
  return db.transaction().execute(async (trx) => {
    if (!await lockRunOf(trx, input.intent_id)) return { kind: "missing" };
    const intent = await trx.selectFrom("authority.effect_intent").select(["status", "tries"]).where("id", "=", input.intent_id).executeTakeFirstOrThrow();
    if (intent.status !== "pending") return { kind: "not_pending", status: intent.status };
    if (intent.tries >= input.max_tries) return { kind: "exhausted", tries: intent.tries };
    const claimed = await trx.updateTable("authority.effect_intent").set((eb) => ({ tries: eb("tries", "+", 1), next_try_at: null, updated_at: new Date() }))
      .where("id", "=", input.intent_id).returning("tries").executeTakeFirstOrThrow();
    return { kind: "claimed", tries: claimed.tries };
  });
}

/** A start that did not get a definite answer: when the next try may run, and why this one did not succeed. */
export async function recordTryFailure(db: Database, input: { readonly intent_id: string; readonly last_error: string; readonly next_try_at: Date }): Promise<EffectStatus | null> {
  const row = await db.updateTable("authority.effect_intent").set({ last_error: input.last_error, next_try_at: input.next_try_at, updated_at: new Date() })
    .where("id", "=", input.intent_id).returning("status").executeTakeFirst();
  return row?.status ?? null;
}

/** The provider accepted the start. A stop requested meanwhile is kept: its carrier owns the execution now. */
export async function markAcknowledged(db: Database, intent_id: string): Promise<EffectStatus | null> {
  return db.transaction().execute(async (trx) => {
    if (!await lockRunOf(trx, intent_id)) return null;
    const row = await trx.updateTable("authority.effect_intent").set({ status: "acknowledged", last_error: null, updated_at: new Date() })
      .where("id", "=", intent_id).where("status", "=", "pending").returning("status").executeTakeFirst();
    if (row) return row.status;
    return (await trx.selectFrom("authority.effect_intent").select("status").where("id", "=", intent_id).executeTakeFirst())?.status ?? null;
  });
}

/**
 * The attempt failed while an execution may still exist (a live session, or a
 * start whose answer never came): its stop is requested, and the cleanup
 * carrier settles it only once the provider confirms the stop.
 */
export async function abandonIntent(db: Database, input: { readonly intent_id: string; readonly last_error: string }): Promise<EffectStatus | null> {
  return db.transaction().execute(async (trx) => {
    if (!await lockRunOf(trx, input.intent_id)) return null;
    await trx.updateTable("authority.effect_intent").set({ status: "stop_requested", last_error: input.last_error, next_try_at: null, updated_at: new Date() })
      .where("id", "=", input.intent_id).where("status", "in", ["pending", "acknowledged"]).execute();
    return (await trx.selectFrom("authority.effect_intent").select("status").where("id", "=", input.intent_id).executeTakeFirst())?.status ?? null;
  });
}

/** The intent owns no external execution any more. Settling is final: a settled intent is never reopened. */
export async function settleIntent(db: Database, input: { readonly intent_id: string; readonly status: SettledStatus; readonly last_error: string | null }): Promise<EffectStatus | null> {
  return db.transaction().execute(async (trx) => {
    if (!await lockRunOf(trx, input.intent_id)) return null;
    await trx.updateTable("authority.effect_intent").set({ status: input.status, last_error: input.last_error, next_try_at: null, updated_at: new Date() })
      .where("id", "=", input.intent_id).where("status", "not in", SETTLED_STATUSES).execute();
    return (await trx.selectFrom("authority.effect_intent").select("status").where("id", "=", input.intent_id).executeTakeFirst())?.status ?? null;
  });
}

/** The kbbl session an attempt reported when it started, for a stop. */
export async function readAttemptSession(db: Reader, input: { readonly action_id: string; readonly seq: number }): Promise<string | null> {
  const attempt = await db.selectFrom("authority.attempt").select("kbbl_session_id")
    .where("action_id", "=", input.action_id).where("seq", "=", input.seq).executeTakeFirst();
  return attempt?.kbbl_session_id ?? null;
}

/** An action's latest attempt: where a carrier resumes a periodic worker after another engine version ran it. */
export interface LatestAttempt { readonly seq: number; readonly status: AttemptRecord["status"] }
export async function readLatestAttempt(db: Reader, action_id: string): Promise<LatestAttempt | null> {
  const attempt = await db.selectFrom("authority.attempt").select(["seq", "status"]).where("action_id", "=", action_id)
    .orderBy("seq", "desc").executeTakeFirst();
  return attempt ?? null;
}
