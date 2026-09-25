// The run-level selectors the command center reads — `selectRunOverview` for
// the overview pane, plus the two small derivations the sidebar shares with it.
//
// Everything here is a pure function of data already on screen: `GET /runs/:id`,
// `GET /runs/:id/sessions` (via c1's `selectRunSessionRows`) and
// `GET /runs/:id/gates`. No per-session or per-artifact fetch is added, and no
// component re-derives any of it in a render body.

import type { ArtifactId, Sid } from "../../lib/ids";
import type {
  ParkedGate,
  RunDetail,
  RunSessionAttempt,
  RunStatus,
  StageStatus,
  WorkOrderState,
} from "../types";
import { selectRunSessionRows, type RunSessionRow } from "./run-sessions";

/** How many artifact releases the overview lists before "recent" stops meaning anything. */
export const RECENT_SLOT_RELEASE_LIMIT = 8;

/**
 * What the run's gate read currently knows.
 *
 * A failed read is not an empty gate list. Collapsing the two lets a backend
 * outage render as "no gate is open" and drop every "needs you" marker, which
 * is the one message an outage must never be able to send — the operator reads
 * it as "nothing wants me" and walks away from a parked run.
 */
export type RunGatesRead =
  | { readonly kind: "loaded"; readonly gates: readonly ParkedGate[] }
  | { readonly kind: "pending" }
  | { readonly kind: "unavailable" };

export interface RunGatesQueryState {
  /** The last successful payload — absent while first loading, and after a first load that failed. */
  readonly gates: readonly ParkedGate[] | undefined;
  readonly is_pending: boolean;
  readonly is_error: boolean;
}

/**
 * The gate read behind a polling query.
 *
 * Stale gates beat no gates: the query layer keeps the last successful payload
 * across a failed poll, and a list from ten seconds ago still answers "is
 * anything waiting on me". Only a read that never produced one is unavailable.
 */
export const selectRunGatesRead = ({
  gates,
  is_pending,
  is_error,
}: RunGatesQueryState): RunGatesRead => {
  if (gates !== undefined) return { kind: "loaded", gates };
  // Unavailable only once the read has settled with nothing — a first attempt
  // still in flight has not failed, and saying so would flash a warning on
  // every load. Anything else the query layer can be in is still "not yet".
  if (is_error && !is_pending) return { kind: "unavailable" };
  return { kind: "pending" };
};

/**
 * A unit's identity as the *gate* list spells it — `stage_name:unit_id`.
 *
 * `ParkedGate.stage_name` and `StageDetail.name` are both the stage's
 * `stage_key` (oakridge-dbos `postgres-operators.ts` projects the stage as
 * `name: stage_key`), and `RunSessionAttempt.stage_key` is that same column, so
 * an attempt and a gate on the same unit produce the same key.
 */
export type UnitActionKey = string & { readonly __brand: "UnitActionKey" };

export const unitActionKeyOf = (stageKey: string, unitId: string): UnitActionKey =>
  `${stageKey}:${unitId}` as UnitActionKey;

/**
 * The units where the run is waiting on a person. A gate that is no longer
 * `actionable` is one the run moved past while it sat open — it is stranded,
 * not pending, and counting it would tell the operator to act on nothing.
 */
export const selectUnitsAwaitingAction = (
  gates: readonly ParkedGate[],
): ReadonlySet<UnitActionKey> => {
  const keys = new Set<UnitActionKey>();
  for (const gate of gates) {
    if (gate.actionable) keys.add(unitActionKeyOf(gate.stage_name, gate.unit_id));
  }
  return keys;
};

/** "attempt 2 of 3" for a retried unit, "attempt 1" for one that ran once. */
export const formatAttemptLabel = (row: RunSessionRow): string =>
  row.attempt_count > 1
    ? `attempt ${row.attempt_number} of ${row.attempt_count}`
    : `attempt ${row.attempt_number}`;

export interface RunOverviewSessionRef {
  readonly session_id: Sid;
  readonly stage_key: string;
  readonly unit_id: string;
  readonly attempt_label: string;
  readonly work_order_state: WorkOrderState;
}

export interface RunOverviewGate {
  readonly gate_id: string;
  readonly gate_type: string;
  readonly stage_name: string;
  readonly unit_id: string;
  readonly resume_actions: readonly string[];
}

/**
 * One artifact the run holds, flattened out of `run.stages[].artifacts` with
 * its producing stage attached. The overview reads these sorted and capped as
 * recent slot releases; the sidebar reads them in stage order. One flatten,
 * two views.
 */
export interface RunArtifactRef {
  readonly artifact_id: ArtifactId;
  readonly type_id: string;
  readonly version: number;
  readonly stage_name: string;
  /** The fan-out unit this artifact belongs to, when the stage fanned out. */
  readonly label: string | null;
  /** Absent on a backend older than `OperatorStageArtifact.created_at`. */
  readonly created_at: string | null;
}

/** Every artifact the run holds, in stage order then slot order. */
export const selectRunArtifacts = (run: RunDetail): readonly RunArtifactRef[] => {
  const artifacts: RunArtifactRef[] = [];
  for (const stage of run.stages) {
    for (const artifact of stage.artifacts) {
      artifacts.push({
        artifact_id: artifact.id as ArtifactId,
        type_id: artifact.type_id,
        version: artifact.version,
        stage_name: stage.name,
        label: artifact.label ?? null,
        created_at: artifact.created_at ?? null,
      });
    }
  }
  return artifacts;
};

/** One attempt as the sidebar's Sessions section lists it. */
export interface RunSidebarSessionRow {
  /**
   * The attempt's identity, and the only field on this row guaranteed unique
   * within it. `session_id` is not: `executor_attachment.work_order_id` is the
   * primary key, so nothing stops one session id being attached to two work
   * orders — the backend treats that as unexpected but handles it rather than
   * forbidding it (`find_run_for_session` takes the latest attachment). A list
   * that is one row per work order therefore has to key on the work order.
   */
  readonly work_order_id: string;
  readonly session_id: Sid;
  readonly stage_key: string;
  readonly unit_id: string;
  readonly attempt_label: string;
  readonly work_order_state: WorkOrderState;
  /** Whether this attempt is what its unit currently is, rather than a superseded one. */
  readonly is_current: boolean;
  readonly requires_operator_action: boolean;
}

/**
 * The sidebar's Sessions section.
 *
 * `is_action_state_known` travels with the rows because it is the only thing
 * that distinguishes "no row needs you" from "we could not find out" — without
 * it the section renders identically either way.
 */
export interface RunSidebarSessionsView {
  readonly rows: readonly RunSidebarSessionRow[];
  readonly is_action_state_known: boolean;
}

export interface RunSidebarSessionsInput {
  readonly sessions: readonly RunSessionAttempt[];
  readonly gates: RunGatesRead;
  /**
   * Sids kbbl's inbox has reported purged server-side. Oakridge keeps listing
   * the work order behind a purged session, so without this the sidebar offers
   * a row whose transcript no longer exists.
   */
  readonly purgedSessionIds: ReadonlySet<string>;
}

/**
 * Every session of the run the operator can still open, prior attempts
 * included, in the route's oldest-first order. Only a unit's *current* attempt
 * can require operator action — a superseded attempt has nothing left to decide.
 *
 * A purged session is dropped rather than disabled: the section is a list of
 * what can be opened, and a row that refuses to open says nothing the operator
 * can act on. The filter runs *after* numbering so a surviving row still reads
 * "attempt 2 of 2" — the attempt history is a durable record, and a purge
 * removes the transcript, not the attempt that produced it.
 */
export const selectRunSidebarSessions = ({
  sessions,
  gates,
  purgedSessionIds,
}: RunSidebarSessionsInput): RunSidebarSessionsView => {
  const awaitingAction =
    gates.kind === "loaded" ? selectUnitsAwaitingAction(gates.gates) : null;
  return {
    is_action_state_known: awaitingAction !== null,
    rows: selectRunSessionRows(sessions)
      .filter((row) => !purgedSessionIds.has(row.attempt.session_id))
      .map((row) => ({
        work_order_id: row.attempt.work_order_id,
        session_id: row.attempt.session_id as Sid,
        stage_key: row.attempt.stage_key,
        unit_id: row.attempt.unit_id,
        attempt_label: formatAttemptLabel(row),
        work_order_state: row.attempt.work_order_state,
        is_current: row.is_current,
        requires_operator_action:
          row.is_current &&
          awaitingAction !== null &&
          awaitingAction.has(unitActionKeyOf(row.attempt.stage_key, row.attempt.unit_id)),
      })),
  };
};

export interface RunOverviewStageProgress {
  readonly total: number;
  readonly complete: number;
  readonly running: number;
  readonly parked: number;
  readonly failed: number;
  readonly pending: number;
}

/**
 * Everything the overview derives from the gate list, under one tag.
 *
 * Both fields answer "who is waiting on a decision", so neither is readable
 * without a gate list — grouping them makes that a fact of the type rather than
 * a rule each consumer has to remember.
 */
export type RunOverviewGates =
  | {
      readonly kind: "known";
      readonly active: readonly RunOverviewGate[];
      readonly sessions_awaiting_action: readonly RunOverviewSessionRef[];
    }
  | { readonly kind: "pending" }
  | { readonly kind: "unavailable" };

export interface RunOverview {
  readonly status: RunStatus;
  readonly is_stuck: boolean;
  readonly parked_count: number;
  /** The attempt the run is live in right now, or null when nothing is executing. */
  readonly current_session: RunOverviewSessionRef | null;
  readonly gates: RunOverviewGates;
  readonly recent_slot_releases: readonly RunArtifactRef[];
  readonly stage_progress: RunOverviewStageProgress;
}

export interface RunOverviewInput {
  readonly run: RunDetail;
  readonly sessions: readonly RunSessionAttempt[];
  readonly gates: RunGatesRead;
}

const toSessionRef = (row: RunSessionRow): RunOverviewSessionRef => ({
  session_id: row.attempt.session_id as Sid,
  stage_key: row.attempt.stage_key,
  unit_id: row.attempt.unit_id,
  attempt_label: formatAttemptLabel(row),
  work_order_state: row.attempt.work_order_state,
});

/**
 * The newest current attempt that is actually executing.
 *
 * `selectRunSessionRows` preserves the route's oldest-first order, so the last
 * match is the newest — the same reason c1 reads the list from the end rather
 * than comparing `created_at` strings whose rendered UTC offset nothing pins.
 */
const selectCurrentSession = (rows: readonly RunSessionRow[]): RunOverviewSessionRef | null => {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row.is_current && row.attempt.work_order_state === "started") return toSessionRef(row);
  }
  return null;
};

const selectStageProgress = (run: RunDetail): RunOverviewStageProgress => {
  const counts: Record<StageStatus, number> = {
    pending: 0,
    running: 0,
    complete: 0,
    failed: 0,
    parked: 0,
  };
  for (const stage of run.stages) counts[stage.status] += 1;
  return { total: run.stages.length, ...counts };
};

/**
 * Newest first. Sorted on the parsed instant, not the rendered string: the
 * backend hands these over as `timestamptz::text`, and comparing those
 * lexically reads a DST fold backwards — `01:15:00-05` sorts before
 * `01:30:00-04` but happens 45 minutes after it. Releases with no timestamp
 * keep their document order at the end rather than jumping to the front.
 */
const selectRecentSlotReleases = (run: RunDetail): readonly RunArtifactRef[] => {
  const instantOf = (release: RunArtifactRef): number => {
    if (release.created_at === null) return Number.NEGATIVE_INFINITY;
    const parsed = Date.parse(release.created_at);
    return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
  };
  return [...selectRunArtifacts(run)]
    .sort((left, right) => instantOf(right) - instantOf(left))
    .slice(0, RECENT_SLOT_RELEASE_LIMIT);
};

const selectOverviewGates = (
  rows: readonly RunSessionRow[],
  read: RunGatesRead,
): RunOverviewGates => {
  // `pending` and `unavailable` carry no payload, so the read *is* the answer.
  if (read.kind !== "loaded") return read;
  const awaitingAction = selectUnitsAwaitingAction(read.gates);
  return {
    kind: "known",
    active: read.gates
      .filter((gate) => gate.actionable)
      .map((gate) => ({
        gate_id: gate.id,
        gate_type: gate.gate_type,
        stage_name: gate.stage_name,
        unit_id: gate.unit_id,
        resume_actions: gate.resume_actions,
      })),
    sessions_awaiting_action: rows
      .filter(
        (row) =>
          row.is_current &&
          awaitingAction.has(unitActionKeyOf(row.attempt.stage_key, row.attempt.unit_id)),
      )
      .map(toSessionRef),
  };
};

/** Everything the overview pane renders, derived once. */
export const selectRunOverview = ({ run, sessions, gates }: RunOverviewInput): RunOverview => {
  const rows = selectRunSessionRows(sessions);
  return {
    status: run.status,
    is_stuck: run.is_stuck,
    parked_count: run.parked_count,
    current_session: selectCurrentSession(rows),
    gates: selectOverviewGates(rows, gates),
    recent_slot_releases: selectRecentSlotReleases(run),
    stage_progress: selectStageProgress(run),
  };
};
