import type { SqlExecutor } from "./sql-executor";
import type { SessionPolicy } from "../domain/session-settings";
import type { Cause, Mode, AttemptStatus, ScopedSnapshot, UnitStatus } from "../core-client/core-types";

export interface PolicyWitness { readonly relation: "session_policy"; readonly id: string; readonly version: number }
interface RunPolicyRow { readonly run_id: string; readonly project_id: string | null; readonly session_policy: SessionPolicy | null }
export async function readRunPolicy(tx: SqlExecutor, run_id: string): Promise<{ readonly policy: SessionPolicy; readonly witness: PolicyWitness }> {
  const row = (await tx.query<RunPolicyRow>("SELECT r.id AS run_id,p.id AS project_id,p.session_policy FROM authority.run r LEFT JOIN authority.project p ON p.id=r.project_id WHERE r.id=$1", [run_id]))[0];
  if (!row) throw new Error(`run ${run_id} missing while reading session policy`);
  const policy: SessionPolicy = row.session_policy ?? { version: 0, entries: [] };
  return { policy, witness: { relation: "session_policy", id: row.project_id ?? row.run_id, version: policy.version } };
}

// The v2 evaluator reads the affected unit, its ancestors and the direct
// children needed to recompute each ancestor. Launch has no persisted unit;
// cancellation needs every unit because it terminates the entire run.
export async function readScopedSnapshot(tx: SqlExecutor, run_id: string, unit_id: string | null): Promise<ScopedSnapshot | null> {
  type V2Run = { id: string; root_unit_id: string | null; input: unknown | null; status: UnitStatus };
  type V2Unit = { id: string; parent_id: string | null; declaration: string; stage: string | null; pool: string | null; input: unknown; status: UnitStatus };
  type V2Dependency = { unit_id: string; depends_on_id: string };
  type V2Attempt = { action_id: string; seq: number; unit_id: string; worker: string; mode: Mode; cause: Cause; status: AttemptStatus; ended_at: number | null; kbbl_session_id: string | null };
  type V2Revision = { id: string; unit_id: string; artifact: string; body: unknown; by_id: string; predecessor_id: string | null; subject: string | null };
  type V2Decision = { id: string; unit_id: string; review: string; decision: string; effect: "approve" | "request_changes"; target_revision_id: string; payload: unknown };
  type V2Retry = { unit_id: string; worker: string; event_id: string };
  const run = (await tx.query<V2Run>("SELECT id,root_unit_id,input,status FROM authority.run WHERE id=$1", [run_id]))[0];
  if (!run) return null;
  const units = await tx.query<V2Unit>(`WITH RECURSIVE ancestors AS (
      SELECT id,parent_id FROM authority.unit WHERE run_id=$1 AND id=$2
      UNION ALL SELECT parent.id,parent.parent_id FROM authority.unit parent JOIN ancestors child ON parent.id=child.parent_id WHERE parent.run_id=$1
    ) SELECT id,parent_id,declaration,stage,pool,input,status FROM authority.unit
    WHERE run_id=$1 AND ($2::text IS NULL OR id IN (SELECT id FROM ancestors) OR parent_id IN (SELECT id FROM ancestors))
    ORDER BY id`, [run_id, unit_id]);
  if (unit_id !== null && !units.some((unit) => unit.id === unit_id)) return null;
  const ids = units.map((unit) => unit.id);
  const dependencies = await tx.query<V2Dependency>("SELECT unit_id,depends_on_id FROM authority.unit_dependency WHERE run_id=$1 AND unit_id=ANY($2::text[]) ORDER BY unit_id,depends_on_id", [run_id, ids]);
  const attempts = await tx.query<V2Attempt>("SELECT action_id,seq,unit_id,worker,mode,cause,status,ended_at,kbbl_session_id FROM authority.attempt WHERE run_id=$1 AND unit_id=ANY($2::text[]) ORDER BY action_id,seq", [run_id, ids]);
  const revisions = await tx.query<V2Revision>("SELECT id,unit_id,artifact,body,by_id,predecessor_id,subject FROM authority.artifact_revision WHERE run_id=$1 AND unit_id=ANY($2::text[]) ORDER BY created_at,id", [run_id, ids]);
  const decisions = await tx.query<V2Decision>("SELECT id,unit_id,review,decision,effect,target_revision_id,payload FROM authority.review_decision WHERE run_id=$1 AND unit_id=ANY($2::text[]) ORDER BY id", [run_id, ids]);
  const retries = await tx.query<V2Retry>("SELECT unit_id, payload->>'worker' AS worker,id AS event_id FROM authority.event WHERE run_id=$1 AND payload->>'kind'='retry_requested' AND unit_id=ANY($2::text[]) ORDER BY created_at,id", [run_id, ids]);
  return {
    run: { id: run.id, root: run.root_unit_id ?? run.id, input: run.input ?? undefined, status: run.status },
    units: units.map((unit) => ({ id: unit.id, parent: unit.parent_id, declaration: unit.declaration,
      stage: unit.stage, pool: unit.pool, input: unit.input, status: unit.status,
      after: dependencies.filter((item) => item.unit_id === unit.id).map((item) => item.depends_on_id) })),
    attempts: attempts.map((attempt) => ({ action_id: attempt.action_id, seq: attempt.seq, unit: attempt.unit_id,
      worker: attempt.worker, mode: attempt.mode, cause: attempt.cause, status: attempt.status,
      ended_at: attempt.ended_at, kbbl_session_id: attempt.kbbl_session_id })),
    revisions: revisions.map((revision) => ({ id: revision.id, unit: revision.unit_id, artifact: revision.artifact,
      body: revision.body, by: revision.by_id, predecessor: revision.predecessor_id, subject: revision.subject })),
    decisions: decisions.map((decision) => ({ id: decision.id, unit: decision.unit_id, review: decision.review,
      decision: decision.decision, effect: decision.effect, target: decision.target_revision_id, payload: decision.payload })),
    retry_events: retries.map((retry) => [retry.unit_id, retry.worker, retry.event_id]),
  };
}
