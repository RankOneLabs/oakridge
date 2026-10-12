import { requestDigest } from "./receipts";
import { readScopedSnapshot } from "./snapshot-reader";
import { inTransaction, type SqlExecutor, type TransactionalSqlExecutor } from "./sql-executor";
import type { Result as SharedResult } from "../domain/primitives";
export { MAX_SNAPSHOT_BYTES, measureSnapshotSize } from "../effects/operations/selected-publication-contract";

export interface DomainError { readonly operation: string; readonly entity_id: string; readonly detail: string }
/** A storage result: the shared Result with a traced domain error. */
export type Result<Value> = SharedResult<Value, DomainError>;

/** Serialization and constraint failures are commit outcomes, not faults. */
function databaseFailure(error: unknown): EventCommitResult | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  if (error.code === "40P01" || error.code === "40001") return { kind: "conflict", detail: `database concurrency conflict (${error.code}); retry the event` };
  if (error.code === "23505") {
    const constraint = "constraint" in error && typeof error.constraint === "string" ? error.constraint : "unknown constraint";
    return { kind: "rejected", detail: `unique constraint violated: ${constraint}` };
  }
  return null;
}

/** Runs inside the committing transaction, so an outbox write is atomic with the event. */
export type CommittedHook = (tx: SqlExecutor, committed: { readonly event_id: string; readonly run_id: string; readonly unit_id: string | null }) => Promise<void>;

/** The v2 ingress accepted by the authority. The caller supplies the writer
 * from its verified credential, never from the request body. */
export interface EventCommitRequest {
  readonly run_id: string;
  readonly ingress_id: string | null;
  readonly definition_bundle_id?: string;
  readonly event: import("../core-client/core-types").Event;
  readonly writer: import("../core-client/core-types").Writer;
}
export type EventCommitResult =
  | { readonly kind: "committed"; readonly event_id: string }
  | { readonly kind: "replayed"; readonly event_id: string }
  | { readonly kind: "conflict"; readonly detail: string }
  | { readonly kind: "rejected"; readonly detail: string };
class AbortEventCommit extends Error {
  constructor(readonly result: EventCommitResult) { super(result.kind); }
}

type V2Snapshot = import("../core-client/core-types").ScopedSnapshot;
type V2Step = import("../core-client/core-types").StepResult;
type V2Action = import("../core-client/core-types").Action;

async function affectedUnit(tx: SqlExecutor, run_id: string, event: EventCommitRequest["event"]): Promise<string | null> {
  switch (event.kind) {
    case "launched":
    case "cancel_requested": return null;
    case "revision_published":
    case "operator_decided":
    case "retry_requested": return event.unit;
    case "worker_started":
    case "worker_ended": {
      const row = (await tx.query<{ unit_id: string }>(`SELECT unit_id FROM authority.attempt
        WHERE run_id=$1 AND action_id=$2 ORDER BY seq DESC LIMIT 1`, [run_id, event.action]))[0];
      if (!row) throw new AbortEventCommit({ kind: "rejected", detail: "worker action not found" });
      return row.unit_id;
    }
  }
}

/** The target is checked under the run lock, against the pinned review's
 * artifact. A read performed by an HTTP handler would race another commit. */
async function checkDecisionTarget(tx: SqlExecutor, run_id: string,
  event: EventCommitRequest["event"], source: import("../core-client/core-types").Workflow): Promise<void> {
  if (event.kind !== "operator_decided") return;
  const unit = (await tx.query<{ stage: string | null }>(
    "SELECT stage FROM authority.unit WHERE run_id=$1 AND id=$2", [run_id, event.unit]))[0];
  const artifact = unit?.stage ? source.stages[unit.stage]?.reviews?.[event.review]?.of : null;
  if (!artifact) throw new AbortEventCommit({ kind: "rejected", detail: "review is not declared for this unit" });
  const latest = (await tx.query<{ id: string }>(`SELECT id FROM authority.artifact_revision
    WHERE run_id=$1 AND unit_id=$2 AND artifact=$3 ORDER BY created_at DESC,id DESC LIMIT 1`,
  [run_id, event.unit, artifact]))[0];
  if (latest?.id !== event.target)
    throw new AbortEventCommit({ kind: "conflict", detail: "review target revision changed" });
}

function newUnits(before: V2Snapshot, after: V2Snapshot): V2Snapshot["units"] {
  const known = new Set(before.units.map((unit) => unit.id));
  return after.units.filter((unit) => !known.has(unit.id))
    .sort((left, right) => left.id.split("/").length - right.id.split("/").length);
}

async function writeStepDelta(tx: SqlExecutor, run_id: string, before: V2Snapshot, step: V2Step): Promise<void> {
  const after = step.snapshot;
  await tx.query("UPDATE authority.run SET root_unit_id=$2,input=$3,status=$4,version=version+1 WHERE id=$1",
    [run_id, after.run.root, JSON.stringify(after.run.input ?? null), JSON.stringify(after.run.status)]);
  for (const unit of newUnits(before, after)) {
    const member_key = unit.parent == null ? unit.declaration : unit.id.slice(unit.parent.length + 1);
    await tx.query(`INSERT INTO authority.unit
      (id,run_id,parent_id,unit_key,collection_key,declaration,stage,pool,input,status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [unit.id, run_id, unit.parent, unit.declaration,
      member_key === unit.declaration ? null : member_key, unit.declaration, unit.stage ?? null,
      unit.pool ?? null, JSON.stringify(unit.input), JSON.stringify(unit.status)]);
  }
  for (const unit of after.units) {
    if (before.units.some((old) => old.id === unit.id)) {
      await tx.query("UPDATE authority.unit SET status=$3,version=version+1 WHERE run_id=$1 AND id=$2 AND status IS DISTINCT FROM $3::jsonb",
        [run_id, unit.id, JSON.stringify(unit.status)]);
    } else {
      for (const dependency of unit.after) await tx.query(
        "INSERT INTO authority.unit_dependency (run_id,unit_id,depends_on_id) VALUES ($1,$2,$3)", [run_id, unit.id, dependency]);
    }
  }
  const old_attempts = new Map(before.attempts.map((attempt) => [`${attempt.action_id}:${attempt.seq}`, attempt]));
  for (const attempt of after.attempts) {
    const old = old_attempts.get(`${attempt.action_id}:${attempt.seq}`);
    if (!old) await tx.query(`INSERT INTO authority.attempt
      (action_id,seq,run_id,unit_id,worker,mode,cause,status,ended_at,kbbl_session_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [attempt.action_id, attempt.seq, run_id, attempt.unit,
      attempt.worker, JSON.stringify(attempt.mode), JSON.stringify(attempt.cause), JSON.stringify(attempt.status),
      attempt.ended_at, attempt.kbbl_session_id ?? null]);
    else if (JSON.stringify(old) !== JSON.stringify(attempt)) await tx.query(`UPDATE authority.attempt
      SET status=$4,ended_at=$5,kbbl_session_id=$6 WHERE run_id=$1 AND action_id=$2 AND seq=$3`, [run_id,
      attempt.action_id, attempt.seq, JSON.stringify(attempt.status), attempt.ended_at, attempt.kbbl_session_id ?? null]);
  }
  const old_revisions = new Set(before.revisions.map((revision) => revision.id));
  for (const revision of after.revisions) if (!old_revisions.has(revision.id)) await tx.query(`INSERT INTO authority.artifact_revision
    (id,run_id,unit_id,artifact,body,by_id,predecessor_id,subject) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [revision.id,
    run_id, revision.unit, revision.artifact, JSON.stringify(revision.body), revision.by,
    revision.predecessor ?? null, revision.subject ?? null]);
  const old_decisions = new Set(before.decisions.map((decision) => decision.id));
  for (const decision of after.decisions) if (!old_decisions.has(decision.id)) await tx.query(`INSERT INTO authority.review_decision
    (id,run_id,unit_id,review,decision,effect,target_revision_id,payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [decision.id,
    run_id, decision.unit, decision.review, decision.decision, decision.effect, decision.target,
    JSON.stringify(decision.payload)]);
}

async function reconcileWanted(tx: SqlExecutor, run_id: string, event_id: string, before: V2Snapshot, step: V2Step): Promise<void> {
  type ExistingIntent = { id: string; unit_id: string; action_id: string; seq: number; status: string };
  const old_unit_ids = before.units.map((unit) => unit.id);
  const active = await tx.query<ExistingIntent>(`SELECT id,unit_id,action_id,seq,status FROM authority.effect_intent
    WHERE run_id=$1 AND unit_id=ANY($2::text[]) AND status IN ('pending','acknowledged','stop_requested')`,
    [run_id, old_unit_ids]);
  const wanted_by_unit = step.wanted as unknown as readonly (readonly [string, readonly V2Action[]])[];
  const actions = wanted_by_unit.flatMap(([unit_id, wanted]) => wanted.map((action) => ({ unit_id, action })));
  const wanted_keys = new Set<string>();
  for (const { unit_id, action } of actions) {
    if (action.kind !== "run_worker") continue;
    const attempt = step.snapshot.attempts.find((candidate) => candidate.unit === unit_id && candidate.worker === action.worker
      && JSON.stringify(candidate.mode) === JSON.stringify(action.mode) && JSON.stringify(candidate.cause) === JSON.stringify(action.cause));
    if (!attempt) throw new Error(`wanted worker ${unit_id}/${action.worker} has no attempt`);
    const key = `${attempt.action_id}:${attempt.seq}`;
    wanted_keys.add(key);
    if (!active.some((intent) => `${intent.action_id}:${intent.seq}` === key)) await tx.query(`INSERT INTO authority.effect_intent
      (id,run_id,unit_id,action_id,seq,payload) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (action_id,seq) DO NOTHING`,
      [crypto.randomUUID(), run_id, unit_id, attempt.action_id, attempt.seq, JSON.stringify(action satisfies V2Action)]);
  }
  for (const intent of active) {
    if (wanted_keys.has(`${intent.action_id}:${intent.seq}`)) continue;
    const attempt = step.snapshot.attempts.find((candidate) => candidate.action_id === intent.action_id && candidate.seq === intent.seq);
    const owner = step.snapshot.units.find((unit) => unit.id === intent.unit_id);
    // The evaluator removes a worker from wanted as soon as it starts. That
    // does not revoke its authority: an active running attempt still owns it.
    if (attempt?.status.kind === "running" && owner?.status.kind === "active") continue;
    const status = attempt?.status.kind === "succeeded" ? "stopped"
      : attempt?.status.kind === "failed" ? "failed" : "stop_requested";
    if (intent.status !== status) await tx.query(
      "UPDATE authority.effect_intent SET status=$2,updated_at=now() WHERE id=$1", [intent.id, status]);
  }
  for (const [unit_id, wanted] of wanted_by_unit) await tx.query(
    "INSERT INTO authority.wanted_log (id,run_id,unit_id,event_id,actions) VALUES ($1,$2,$3,$4,$5)",
    [crypto.randomUUID(), run_id, unit_id, event_id, JSON.stringify(wanted)]);
}

/** Run-row locking serializes every event. Snapshot, Rust step, delta, wanted
 * reconciliation, event and ingress receipt share one transaction. */
export async function commitEvent(db: TransactionalSqlExecutor, core: import("../core-client/client").CoreClient,
  request: EventCommitRequest, on_committed?: CommittedHook): Promise<Result<EventCommitResult>> {
  try {
    return { ok: true, value: await db.transaction(async (tx): Promise<EventCommitResult> => {
      if (request.event.kind === "launched") {
        if (!request.definition_bundle_id) return { kind: "rejected", detail: "definition bundle required for launch" };
        await tx.query(`INSERT INTO authority.run (id,definition_bundle_id)
          VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`, [request.run_id, request.definition_bundle_id]);
      }
      const runs = await tx.query<{ id: string; definition_bundle_id: string }>(
        "SELECT id,definition_bundle_id FROM authority.run WHERE id=$1 FOR UPDATE", [request.run_id]);
      const run = runs[0];
      if (!run) return { kind: "rejected", detail: "run not found" };
      if (request.definition_bundle_id && run.definition_bundle_id !== request.definition_bundle_id)
        return { kind: "conflict", detail: "run pinned to a different definition" };
      const digest = requestDigest({ event: request.event, writer: request.writer });
      if (request.ingress_id !== null) {
        const receipts = await tx.query<{ request_digest: string; result: { event_id: string } }>(
          "SELECT request_digest,result FROM authority.ingress_receipt WHERE run_id=$1 AND ingress_id=$2",
          [request.run_id, request.ingress_id]);
        const receipt = receipts[0];
        if (receipt) return receipt.request_digest === digest
          ? { kind: "replayed", event_id: receipt.result.event_id }
          : { kind: "conflict", detail: "ingress ID reused with different content" };
      }
      const definition = (await tx.query<{ digest: string; source: import("../core-client/core-types").Workflow }>(
        "SELECT digest,source FROM authority.definition_bundle WHERE id=$1", [run.definition_bundle_id]))[0];
      if (!definition) throw new AbortEventCommit({ kind: "rejected", detail: "pinned definition missing" });
      await checkDecisionTarget(tx, request.run_id, request.event, definition.source);
      const unit_id = await affectedUnit(tx, request.run_id, request.event);
      const snapshot = await readScopedSnapshot(inTransaction(tx), request.run_id, unit_id);
      if (!snapshot) throw new AbortEventCommit({ kind: "rejected", detail: "affected unit not found" });
      const incoming = { event: request.event, writer: request.writer, ingress_id: request.ingress_id };
      const evaluated = await core.request("step", { workflow_digest: definition.digest, snapshot, incoming });
      if (!evaluated.ok) throw new AbortEventCommit({ kind: "rejected", detail: JSON.stringify(evaluated.error) });
      if (evaluated.value.kind !== "stepped") throw new AbortEventCommit({ kind: "rejected", detail: "core returned non-step output" });
      const step = evaluated.value.value;
      await writeStepDelta(tx, request.run_id, snapshot, step);
      const event_id = crypto.randomUUID();
      await tx.query(`INSERT INTO authority.event (id,run_id,unit_id,ingress_id,payload,writer)
        VALUES ($1,$2,$3,$4,$5,$6)`, [event_id, request.run_id, unit_id, request.ingress_id,
        JSON.stringify(request.event), JSON.stringify(request.writer)]);
      await reconcileWanted(tx, request.run_id, event_id, snapshot, step);
      if (request.ingress_id !== null) await tx.query(`INSERT INTO authority.ingress_receipt
        (id,run_id,unit_id,ingress_id,request_digest,result) VALUES ($1,$2,$3,$4,$5,$6)`,
      [crypto.randomUUID(), request.run_id, unit_id, request.ingress_id, digest, JSON.stringify({ event_id })]);
      if (on_committed) await on_committed(tx, { event_id, run_id: request.run_id, unit_id });
      return { kind: "committed", event_id };
    }) };
  } catch (error) {
    if (error instanceof AbortEventCommit) return { ok: true, value: error.result };
    const mapped = databaseFailure(error);
    if (mapped) return { ok: true, value: { kind: "conflict", detail: "detail" in mapped ? mapped.detail : mapped.kind } };
    return { ok: false, error: { operation: "commit_event", entity_id: request.run_id, detail: String(error) } };
  }
}
