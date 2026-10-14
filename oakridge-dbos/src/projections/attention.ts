import type { BlockedReason, Event, ResolvedDecision } from "../core-client/core-types";
import type { RetryRequest, RunSummaryRead } from "../storage/read-store";
import { isTerminalStatus } from "../domain/unit-status";
import type { AttemptRecord, UnitRecord } from "../storage/schema-records";
import { selectUnitLabel, selectUnitTree } from "./unit-label";

/**
 * What needs the operator, derived from state (part 1 §12: there is no
 * stored ask). The unit view, the inbox, the inspect view and the event
 * stream all read attention through this module.
 */
export interface AwaitingReview {
  readonly unit_id: string;
  readonly review: string;
  /** The revision the review reviews. */
  readonly target: string;
  /** The review's decisions legal now, each with the revision it must name, as the core resolved them. */
  readonly decisions: readonly ResolvedDecision[];
  readonly prompt: string;
}
export interface StalledWorker { readonly unit_id: string; readonly worker: string; readonly action_id: string; readonly seq: number; readonly code: string; readonly detail: string }
/**
 * Where the run could not advance (D-V4): step refused an event because
 * advancing past it stopped here (`stalled`), or commit faulted on an event
 * here (`faulted`). The operator investigates, and cancels the run if need be.
 */
export interface RunStall {
  readonly kind: "stalled" | "faulted";
  /** Where advancing stopped; for a fault, the unit its event addressed (the root for a launch or a cancel). */
  readonly unit_id: string;
  readonly reason: string;
  /** The event it refused or faulted on. */
  readonly event: Event;
  readonly ingress_id: string | null;
  /** When it was refused or recorded (ISO-8601). */
  readonly at: string;
}
export interface UnitAttention {
  readonly unit_id: string;
  /** The run's stalls shown on this unit, oldest first. */
  readonly run_stalls: readonly RunStall[];
  /** Operator reviews a decision is legal on now, as commit rendered them onto the unit. */
  readonly awaiting: readonly AwaitingReview[];
  /** Workers whose latest attempt failed, with no retry pending for them. */
  readonly stalled: readonly StalledWorker[];
  readonly blocked: BlockedReason | null;
}
/**
 * The unit's one-line attention: `waiting` while it is parked (a review
 * awaits, or it is blocked), `stalled` while a worker's last attempt failed.
 */
export type Attention = { readonly kind: "waiting"; readonly reason: string } | { readonly kind: "stalled"; readonly detail: string };

/** A worker on one unit, as its attempts and retry requests name it. */
interface WorkerOnUnit { readonly unit_id: string; readonly worker: string }
/** The key a worker's attempts and retries on one unit share. */
export const selectAttemptWorkerKey = (worker: WorkerOnUnit): string => `${worker.unit_id}:${worker.worker}`;

/**
 * The attempt each worker is judged by, as the core judges it: its last on
 * the unit in the order commit opened them. Attempts arrive in that order.
 */
export function selectLatestAttempts(attempts: readonly AttemptRecord[]): ReadonlyMap<string, AttemptRecord> {
  return new Map(attempts.map((attempt) => [selectAttemptWorkerKey(attempt), attempt]));
}

/**
 * A retry the core has yet to spend on the worker: its latest requested retry,
 * while no attempt carries it (a retry authorizes exactly one attempt).
 * Retries arrive in the order they were requested.
 */
function hasUnspentRetry(worker: WorkerOnUnit, sources: Pick<StallSources, "attempts" | "retries">): boolean {
  const key = selectAttemptWorkerKey(worker);
  const latest = sources.retries.filter((retry) => selectAttemptWorkerKey(retry) === key).at(-1);
  if (!latest) return false;
  return !sources.attempts.some((attempt) => selectAttemptWorkerKey(attempt) === key
    && attempt.cause.kind === "retry" && attempt.cause.event === latest.retry_id);
}

interface StallSources {
  readonly units: readonly Pick<UnitRecord, "id" | "status">[];
  readonly attempts: readonly AttemptRecord[];
  readonly retries: readonly RetryRequest[];
}
/**
 * A worker is stalled where the core would accept a retry of it: its unit is
 * active, its latest attempt failed, and no retry is pending for it.
 */
export function selectStalledWorkers(sources: StallSources): readonly StalledWorker[] {
  const active = new Set(sources.units.filter((unit) => unit.status.kind === "active").map((unit) => unit.id));
  return [...selectLatestAttempts(sources.attempts).values()].flatMap((attempt) => {
    if (attempt.status.kind !== "failed" || !active.has(attempt.unit_id)) return [];
    if (hasUnspentRetry(attempt, sources)) return [];
    return [{ unit_id: attempt.unit_id, worker: attempt.worker, action_id: attempt.action_id, seq: attempt.seq,
      code: attempt.status.code, detail: attempt.status.detail }];
  }).sort((left, right) => left.unit_id.localeCompare(right.unit_id) || left.worker.localeCompare(right.worker));
}

/** The latest event committed on a unit, or on the run as a whole for null. */
function latestEventOn(read: Pick<RunSummaryRead, "latest_events">, unit_id: string | null): string | null {
  const candidates = unit_id === null ? read.latest_events : read.latest_events.filter((event) => event.unit_id === unit_id);
  const latest = candidates.reduce<RunSummaryRead["latest_events"][number] | null>((best, event) => !best
    || event.created_at.getTime() > best.created_at.getTime()
    || event.created_at.getTime() === best.created_at.getTime() && event.event_id > best.event_id ? event : best, null);
  return latest?.event_id ?? null;
}

type RunStallSources = Pick<RunSummaryRead, "run" | "units" | "stalls" | "faults" | "latest_events">;
/**
 * The stalls and faults that stand: the run is live, and nothing has committed
 * on the refused event's unit since. Oldest first; a repeat of one unit and
 * reason keeps only its latest occurrence, in that occurrence's place.
 */
export function selectRunStalls(read: RunStallSources): readonly RunStall[] {
  if (isTerminalStatus(read.run.status)) return [];
  const root = read.run.root_unit_id ?? read.run.id;
  const shownOn = (unit_id: string | null): string => unit_id !== null && read.units.some((unit) => unit.id === unit_id) ? unit_id : root;
  const stalls = read.stalls.filter((refusal) => latestEventOn(read, refusal.unit_id) === refusal.stall.after_event)
    .map((refusal): RunStall => ({ kind: "stalled", unit_id: shownOn(refusal.stall.unit_id), reason: refusal.reason, event: refusal.stall.event,
      ingress_id: refusal.ingress_id, at: refusal.stall.refused_at }));
  const faults = read.faults.filter(({ notice }) => latestEventOn(read, notice.unit_id) === notice.after_event)
    .map(({ notice, recorded_at }): RunStall => ({ kind: "faulted", unit_id: shownOn(notice.at_unit ?? notice.unit_id), reason: notice.detail,
      event: notice.event, ingress_id: notice.ingress_id, at: recorded_at.toISOString() }));
  const latest = new Map<string, RunStall>();
  for (const stall of [...stalls, ...faults].sort((left, right) => left.at.localeCompare(right.at))) {
    const key = `${stall.kind}\u0000${stall.unit_id}\u0000${stall.reason}`;
    // Delete first: a Map keeps a replaced key where it was first inserted.
    latest.delete(key);
    latest.set(key, stall);
  }
  return [...latest.values()];
}

/** The line a stalled worker shows: the worker, and how its latest attempt failed. */
export const selectStalledWorkerDetail = (worker: Pick<StalledWorker, "worker" | "detail">): string => `${worker.worker} failed: ${worker.detail}`;

/** The line a run stall shows: why the run stopped, and the event it refused. */
export function selectRunStallDetail(stall: RunStall): string {
  return stall.kind === "stalled" ? `${stall.reason} (refused ${stall.event.kind})`
    : `commit faulted on ${stall.event.kind}: ${stall.reason}`;
}

/** Every unit's attention, in unit order. */
export function selectRunAttention(read: RunSummaryRead): readonly UnitAttention[] {
  const stalled = selectStalledWorkers(read);
  const run_stalls = selectRunStalls(read);
  return read.units.map((unit) => ({ unit_id: unit.id, run_stalls: run_stalls.filter((stall) => stall.unit_id === unit.id),
    awaiting: Object.entries(unit.review_prompts).sort(([left], [right]) => left.localeCompare(right))
      .map(([review, awaiting]) => ({ unit_id: unit.id, review, target: awaiting.target, decisions: awaiting.decisions, prompt: awaiting.prompt })),
    stalled: stalled.filter((worker) => worker.unit_id === unit.id),
    blocked: unit.status.kind === "blocked" ? unit.status.reason : null }));
}

/** A blocked unit's reason, naming the units it waits on by their labels. */
function blockedReason(reason: BlockedReason, read: RunSummaryRead): string {
  if (reason.kind === "capacity") return `waiting for capacity in ${reason.pool}`;
  const tree = selectUnitTree(read.units, read.definition.workflow);
  const labels = reason.units.map((id) => {
    const unit = read.units.find((candidate) => candidate.id === id);
    return unit ? selectUnitLabel(unit, tree) : id;
  });
  return `waiting on ${labels.join(", ")}`;
}

/** The one line the unit view shows: the run's stall first, then a stalled worker, then an awaiting review, then a block. */
export function selectAttention(attention: UnitAttention, read: RunSummaryRead): Attention | null {
  const run_stall = attention.run_stalls.at(-1);
  if (run_stall) return { kind: "stalled", detail: selectRunStallDetail(run_stall) };
  const [stalled] = attention.stalled;
  if (stalled) return { kind: "stalled", detail: selectStalledWorkerDetail(stalled) };
  const [awaiting] = attention.awaiting;
  if (awaiting) return { kind: "waiting", reason: `awaiting ${awaiting.review} review` };
  if (attention.blocked) return { kind: "waiting", reason: blockedReason(attention.blocked, read) };
  return null;
}
