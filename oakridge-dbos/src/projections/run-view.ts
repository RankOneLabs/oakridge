import type { RunId } from "../storage/schema-records";
import type { Action, ScopedSnapshot, UnitStatus } from "../core-client/core-types";
import type { SqlExecutor } from "../storage/sql-executor";
import { readScopedSnapshot } from "../storage/snapshot-reader";

export interface RunScopeSummary { readonly scope_id: string; readonly scope_key: string; readonly label: string; readonly version: number; readonly is_terminal: boolean; readonly available_commands: readonly string[] }
export interface RunSummary { readonly run_id: RunId; readonly definition_bundle_id: string; readonly definition_digest: string; readonly version: number;
  readonly created_at: Date; readonly archived_at: Date | null }
export interface RunView extends RunSummary {
  readonly cursor: readonly { readonly scope_id: string; readonly version: number }[]; readonly scopes: readonly RunScopeSummary[] }
/** The run endpoint's complete projection. */
export type RunDetail = RunView;
export interface RunPage { readonly items: readonly RunView[]; readonly next_cursor: string | null }

export interface InspectAttention {
  readonly kind: "stalled_worker";
  readonly unit_id: string;
  readonly worker: string;
  readonly action_id: string;
  readonly detail: string;
}
export interface RunInspectView {
  readonly run_id: string;
  readonly status: UnitStatus;
  readonly units: readonly { readonly id: string; readonly stage: string | null; readonly status: UnitStatus }[];
  readonly attention: readonly InspectAttention[];
}
export interface LatestWanted { readonly unit_id: string; readonly actions: readonly Action[] }

/** A failed attempt leaves its unit active. Surface it when no retry is
 * pending and the latest wanted set has no work for that worker. */
export function selectInspectAttention(snapshot: ScopedSnapshot, wanted: readonly LatestWanted[]): readonly InspectAttention[] {
  const actions = new Map(wanted.map((item) => [item.unit_id, item.actions]));
  const retry_event = new Map<string, string>();
  for (const retry of snapshot.retry_events) {
    const [unit_id, worker, event_id] = retry;
    if (typeof unit_id === "string" && typeof worker === "string" && typeof event_id === "string")
      retry_event.set(`${unit_id}:${worker}`, event_id);
  }
  const latest = new Map<string, ScopedSnapshot["attempts"][number]>();
  for (const attempt of snapshot.attempts) {
    const key = `${attempt.unit}:${attempt.worker}`;
    const previous = latest.get(key);
    const wanted_retry = retry_event.get(key);
    const is_current_retry = attempt.cause.kind === "retry" && attempt.cause.event === wanted_retry;
    const was_current_retry = previous?.cause.kind === "retry" && previous.cause.event === wanted_retry;
    const is_open = attempt.status.kind === "pending" || attempt.status.kind === "running";
    const was_open = previous?.status.kind === "pending" || previous?.status.kind === "running";
    if (!previous || is_current_retry && !was_current_retry || is_current_retry === was_current_retry
      && (is_open && !was_open || is_open === was_open && attempt.seq >= previous.seq))
      latest.set(key, attempt);
  }
  const attention: InspectAttention[] = [];
  for (const attempt of latest.values()) {
    if (attempt.status.kind !== "failed") continue;
    const unit = snapshot.units.find((item) => item.id === attempt.unit);
    if (!unit || unit.status.kind !== "active") continue;
    if ((actions.get(attempt.unit) ?? []).some((action) => action.kind === "run_worker" && action.worker === attempt.worker)) continue;
    attention.push({ kind: "stalled_worker", unit_id: attempt.unit, worker: attempt.worker,
      action_id: attempt.action_id, detail: attempt.status.detail });
  }
  return attention.sort((left, right) => left.unit_id.localeCompare(right.unit_id) || left.worker.localeCompare(right.worker));
}

export async function readRunInspect(db: SqlExecutor, run_id: string): Promise<RunInspectView | null> {
  const snapshot = await readScopedSnapshot(db, run_id, null);
  if (!snapshot) return null;
  const wanted = await db.query<LatestWanted>(`SELECT DISTINCT ON (w.unit_id) w.unit_id,w.actions
    FROM authority.wanted_log w JOIN authority.event e ON e.run_id=w.run_id AND e.id=w.event_id
    WHERE w.run_id=$1 ORDER BY w.unit_id,e.created_at DESC,e.id DESC`, [run_id]);
  return { run_id, status: snapshot.run.status,
    units: snapshot.units.map((unit) => ({ id: unit.id, stage: unit.stage ?? null, status: unit.status })),
    attention: selectInspectAttention(snapshot, wanted) };
}
