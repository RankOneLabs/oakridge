import type { Kysely } from "kysely";
import type { ScopedSnapshot } from "../core-client/core-types";
import type { DB } from "./db-types";
import { anyOf, type DatabaseTransaction } from "./database";

type Reader = Kysely<DB> | DatabaseTransaction;

/**
 * The scoped snapshot `step` needs for one event: the affected unit, its
 * ancestors and every direct child of an ancestor (so each ancestor can be
 * recomputed), with the attempts, revisions, decisions and retries of those
 * units. With no affected unit (launch, cancel) it is the whole run.
 */
export async function readScopedSnapshot(db: Reader, run_id: string, unit_id: string | null): Promise<ScopedSnapshot | null> {
  const run = await db.selectFrom("authority.run").select(["id", "root_unit_id", "input", "status"])
    .where("id", "=", run_id).executeTakeFirst();
  if (!run) return null;
  const units = await readScopedUnits(db, run_id, unit_id);
  if (unit_id !== null && !units.some((unit) => unit.id === unit_id)) return null;
  const ids = units.map((unit) => unit.id);
  const [dependencies, attempts, revisions, decisions, retries] = ids.length === 0 ? [[], [], [], [], []] : await Promise.all([
    db.selectFrom("authority.unit_dependency").select(["unit_id", "depends_on_id"])
      .where("run_id", "=", run_id).where("unit_id", "=", anyOf(ids)).orderBy("unit_id").orderBy("depends_on_id").execute(),
    db.selectFrom("authority.attempt").select(["action_id", "seq", "unit_id", "worker", "mode", "cause", "status", "ended_at", "kbbl_session_id"])
      .where("run_id", "=", run_id).where("unit_id", "=", anyOf(ids)).orderBy("action_id").orderBy("seq").execute(),
    db.selectFrom("authority.artifact_revision").select(["id", "unit_id", "artifact", "body", "by_id", "predecessor_id", "subject"])
      .where("run_id", "=", run_id).where("unit_id", "=", anyOf(ids)).orderBy("created_at").orderBy("id").execute(),
    db.selectFrom("authority.review_decision").select(["id", "unit_id", "review", "decision", "effect", "target_revision_id", "payload"])
      .where("run_id", "=", run_id).where("unit_id", "=", anyOf(ids)).orderBy("id").execute(),
    db.selectFrom("authority.event").select(["id", "unit_id", "payload"])
      .where("run_id", "=", run_id).where("unit_id", "=", anyOf(ids))
      .where((eb) => eb.ref("payload", "->>").key("kind"), "=", "retry_requested")
      .orderBy("created_at").orderBy("id").execute(),
  ]);
  return {
    run: { id: run.id, root: run.root_unit_id ?? run.id, input: run.input, status: run.status },
    units: units.map((unit) => ({ id: unit.id, parent: unit.parent_id, declaration: unit.declaration, stage: unit.stage,
      pool: unit.pool, input: unit.input, status: unit.status,
      after: dependencies.filter((item) => item.unit_id === unit.id).map((item) => item.depends_on_id) })),
    attempts: attempts.map((attempt) => ({ action_id: attempt.action_id, seq: attempt.seq, unit: attempt.unit_id,
      worker: attempt.worker, mode: attempt.mode, cause: attempt.cause, status: attempt.status,
      ended_at: attempt.ended_at, kbbl_session_id: attempt.kbbl_session_id })),
    revisions: revisions.map((revision) => ({ id: revision.id, unit: revision.unit_id, artifact: revision.artifact,
      body: revision.body, by: revision.by_id, predecessor: revision.predecessor_id, subject: revision.subject })),
    decisions: decisions.map((decision) => ({ id: decision.id, unit: decision.unit_id, review: decision.review,
      decision: decision.decision, effect: decision.effect as "approve" | "request_changes", target: decision.target_revision_id, payload: decision.payload })),
    retry_events: retries.flatMap((retry) => retry.payload.kind === "retry_requested" && retry.unit_id !== null
      ? [[retry.unit_id, retry.payload.worker, retry.id]] : []),
  };
}

async function readScopedUnits(db: Reader, run_id: string, unit_id: string | null) {
  const columns = ["id", "parent_id", "declaration", "stage", "pool", "input", "status"] as const;
  if (unit_id === null) return db.selectFrom("authority.unit").select(columns).where("run_id", "=", run_id).orderBy("id").execute();
  return db.withRecursive("ancestors(id, parent_id)", (recursive) => recursive.selectFrom("authority.unit")
    .select(["id", "parent_id"]).where("run_id", "=", run_id).where("id", "=", unit_id)
    .unionAll((ancestor) => ancestor.selectFrom("authority.unit as parent")
      .innerJoin("ancestors as child", "child.parent_id", "parent.id")
      .select(["parent.id", "parent.parent_id"]).where("parent.run_id", "=", run_id)))
    .selectFrom("authority.unit").select(columns).where("run_id", "=", run_id)
    .where((eb) => eb.or([eb("id", "in", eb.selectFrom("ancestors").select("ancestors.id")),
      eb("parent_id", "in", eb.selectFrom("ancestors").select("ancestors.id"))]))
    .orderBy("id").execute();
}
