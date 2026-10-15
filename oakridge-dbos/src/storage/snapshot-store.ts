import type { Kysely } from "kysely";
import type { StepSnapshot } from "../core-client/core-types";
import { VALIDATION_REVIEW } from "../core-client/core-types";
import type { DB } from "./db-types";
import { anyOf, type DatabaseTransaction } from "./database";

type Reader = Kysely<DB> | DatabaseTransaction;

/**
 * The step snapshot `step` needs for one event: every unit in the run and
 * their evidence. The evaluator may revisit any active group, including a
 * sibling of the affected unit, so its persisted children must be present.
 */
export async function readStepSnapshot(db: Reader, run_id: string, unit_id: string | null): Promise<StepSnapshot | null> {
  const run = await db.selectFrom("authority.run").select(["id", "root_unit_id"])
    .where("id", "=", run_id).executeTakeFirst();
  if (!run) return null;
  const units = await readStepUnits(db, run_id);
  if (unit_id !== null && !units.some((unit) => unit.id === unit_id)) return null;
  const ids = units.map((unit) => unit.id);
  const [dependencies, attempts, revisions, decisions, retries] = ids.length === 0 ? [[], [], [], [], []] : await Promise.all([
    db.selectFrom("authority.unit_dependency").select(["unit_id", "depends_on_id"])
      .where("run_id", "=", run_id).where("unit_id", "=", anyOf(ids)).orderBy("unit_id").orderBy("depends_on_id").execute(),
    db.selectFrom("authority.attempt").select(["action_id", "seq", "unit_id", "worker", "mode", "cause", "status", "kbbl_session_id"])
      // The core reads a worker's latest attempt by position: they go in the order commit opened them, not by (hashed) id.
      .where("run_id", "=", run_id).where("unit_id", "=", anyOf(ids)).orderBy("created_at").orderBy("seq").execute(),
    db.selectFrom("authority.artifact_revision").select(["id", "unit_id", "artifact", "seq", "body", "by_id", "predecessor_id", "subject"])
      .where("run_id", "=", run_id).where("unit_id", "=", anyOf(ids)).orderBy("created_at").orderBy("seq").execute(),
    db.selectFrom("authority.review_decision").select(["id", "unit_id", "review", "decision", "effect", "target_revision_id", "payload", "validation_artifact", "validation_messages"])
      .where("run_id", "=", run_id).where("unit_id", "=", anyOf(ids)).orderBy("created_at").orderBy("id").execute(),
    // A retry's identity is its ingress id: the core names it by that id when it is requested.
    db.selectFrom("authority.event").select(["ingress_id", "unit_id", "payload"])
      .where("run_id", "=", run_id).where("unit_id", "=", anyOf(ids))
      .where((eb) => eb.ref("payload", "->>").key("kind"), "=", "retry_requested")
      .orderBy("created_at").orderBy("id").execute(),
  ]);
  return {
    run: { id: run.id, root: run.root_unit_id ?? run.id },
    units: units.map((unit) => ({ id: unit.id, parent: unit.parent_id, declaration: unit.declaration,
      kind: unit.stage === null ? { kind: "group" as const } : { kind: "stage" as const, stage: unit.stage },
      collection_key: unit.collection_key,
      pool: unit.pool, input: unit.input, status: unit.status,
      after: dependencies.filter((item) => item.unit_id === unit.id).map((item) => item.depends_on_id) })),
    attempts: attempts.map((attempt) => ({ action_id: attempt.action_id, seq: attempt.seq, unit: attempt.unit_id,
      worker: attempt.worker, mode: attempt.mode, cause: attempt.cause, status: attempt.status,
      kbbl_session_id: attempt.kbbl_session_id })),
    revisions: revisions.map((revision) => ({ id: revision.id, unit: revision.unit_id, artifact: revision.artifact, seq: revision.seq,
      body: revision.body, by: revision.by_id, predecessor: revision.predecessor_id, subject: revision.subject })),
    decisions: decisions.map((decision) => decision.review === VALIDATION_REVIEW && decision.validation_artifact !== null
      ? { kind: "validation" as const, id: decision.id, unit: decision.unit_id, artifact: decision.validation_artifact,
        target: decision.target_revision_id, messages: decision.validation_messages ?? [] }
      : { kind: "review" as const, id: decision.id, unit: decision.unit_id, review: decision.review,
        decision: decision.decision, effect: decision.effect === "approve" ? { kind: "approve" as const }
          : { kind: "request_changes" as const, feedback: typeof decision.payload === "object" && decision.payload !== null
            && "feedback" in decision.payload && typeof decision.payload.feedback === "string" ? decision.payload.feedback : "" },
        target: decision.target_revision_id, payload: decision.payload }),
    retry_events: retries.flatMap((retry) => retry.payload.kind === "retry_requested" && retry.unit_id !== null && retry.ingress_id !== null
      ? [{ unit: retry.unit_id, worker: retry.payload.worker, event: retry.ingress_id }] : []),
  };
}

async function readStepUnits(db: Reader, run_id: string) {
  const columns = ["id", "parent_id", "declaration", "stage", "collection_key", "pool", "input", "status"] as const;
  return db.selectFrom("authority.unit").select(columns).where("run_id", "=", run_id).orderBy("id").execute();
}
