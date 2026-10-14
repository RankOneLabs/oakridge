import type { Event, UnitStatus, Writer } from "../core-client/core-types";
import type { DefinitionBundleId, RunId, UnitId } from "../domain/primitives";
import { isTerminalStatus } from "../domain/unit-status";
import type { RunRead, RunSummaryRead } from "../storage/read-store";
import type { EventRecord } from "../storage/schema-records";
import { selectRunAttention, type RunStall, type UnitAttention } from "./attention";
import { selectUnitKey, selectUnitLabel } from "./unit-label";
import { isAsk, selectAttemptViews, selectAvailableDecisions, selectUnitView, type AttemptView, type ArtifactView, type DecisionDefinition, type DecisionSubmit, type UnitView } from "./unit-view";

/** One unit as the run lists it. */
export interface RunUnitSummary {
  readonly unit_id: UnitId;
  readonly unit_key: string;
  readonly label: string;
  readonly stage: string | null;
  readonly status: UnitStatus;
  readonly is_terminal: boolean;
  /** Keys of the decisions that ask for the operator now (not the run's cancel). */
  readonly asks: readonly string[];
}
export interface RunSummary {
  readonly run_id: RunId; readonly definition_bundle_id: DefinitionBundleId; readonly definition_digest: string;
  readonly created_at: Date; readonly archived_at: Date | null;
  /** The root unit's status. */
  readonly status: UnitStatus;
}
export interface RunView extends RunSummary { readonly units: readonly RunUnitSummary[] }
export interface RunPage { readonly items: readonly RunView[]; readonly next_cursor: string | null }

const attentionOf = (attention: readonly UnitAttention[], unit_id: string): UnitAttention =>
  attention.find((item) => item.unit_id === unit_id) ?? { unit_id, run_stalls: [], awaiting: [], stalled: [], blocked: null };

export function selectRunView(read: RunSummaryRead): RunView {
  const attention = selectRunAttention(read);
  return { run_id: read.run.id, definition_bundle_id: read.run.definition_bundle_id, definition_digest: read.definition.digest,
    created_at: read.run.created_at, archived_at: read.run.archived_at, status: read.run.status,
    units: read.units.map((unit) => ({ unit_id: unit.id, unit_key: selectUnitKey(unit), label: selectUnitLabel(unit, read.definition.workflow),
      stage: unit.stage, status: unit.status, is_terminal: isTerminalStatus(unit.status),
      asks: selectAvailableDecisions(read, unit, attentionOf(attention, unit.id)).filter(isAsk).map((decision) => decision.key) })) };
}

/** One unit of a run, or null when the run has no such unit. */
export function selectRunUnitView(read: RunRead, unit_id: string): UnitView | null {
  const unit = read.units.find((candidate) => candidate.id === unit_id);
  return unit ? selectUnitView(read, unit, attentionOf(selectRunAttention(read), unit.id)) : null;
}

// ------------------------------------------------------------- inspect -----

/** What needs attention in the minimal inspect view, with what the decide and retry buttons submit. */
export type InspectAttention =
  /** The run could not advance past `event` (D-V4); the decisions are the run's cancel. */
  | { readonly kind: "stalled_run"; readonly unit_id: string; readonly stall: RunStall["kind"]; readonly reason: string; readonly event: Event;
    readonly decisions: readonly DecisionDefinition[] }
  | { readonly kind: "stalled_worker"; readonly unit_id: string; readonly worker: string; readonly action_id: string; readonly detail: string;
    readonly decisions: readonly DecisionDefinition[] }
  | { readonly kind: "awaiting_review"; readonly unit_id: string; readonly review: string; readonly target: string;
    readonly decisions: readonly DecisionDefinition[] };
export interface InspectEvent { readonly id: string; readonly unit_id: string | null; readonly kind: string; readonly writer: Writer; readonly created_at: Date }
/**
 * The minimal inspect view (part 1 §10.4): the run's units and statuses, what
 * needs attention, artifacts and attempts (with their kbbl sessions), and the
 * writer of each recent event.
 */
export interface RunInspectView {
  readonly run_id: string;
  readonly status: UnitStatus;
  readonly units: readonly { readonly id: string; readonly unit_key: string; readonly label: string; readonly stage: string | null; readonly status: UnitStatus }[];
  readonly attention: readonly InspectAttention[];
  readonly artifacts: readonly ArtifactView[];
  readonly attempts: readonly AttemptView[];
  /** Newest first. */
  readonly events: readonly InspectEvent[];
}

export function selectRunInspect(read: RunRead, events: readonly EventRecord[]): RunInspectView {
  const attention = selectRunAttention(read);
  const views = read.units.map((unit) => selectUnitView(read, unit, attentionOf(attention, unit.id)));
  const decisionsOf = (unit_id: string, submits: (submit: DecisionSubmit) => boolean): readonly DecisionDefinition[] =>
    views.find((view) => view.unit_id === unit_id)?.decisions.filter((decision) => submits(decision.submit)) ?? [];
  return { run_id: read.run.id, status: read.run.status,
    units: views.map((view) => ({ id: view.unit_id, unit_key: view.unit_key, label: view.label, stage: view.stage, status: view.status })),
    attention: attention.flatMap((unit): InspectAttention[] => [
      ...unit.run_stalls.map((stall): InspectAttention => ({ kind: "stalled_run", unit_id: stall.unit_id, stall: stall.kind, reason: stall.reason,
        event: stall.event, decisions: views.flatMap((view) => view.decisions.filter((decision) => decision.submit.kind === "cancel")) })),
      ...unit.stalled.map((stalled): InspectAttention => ({ kind: "stalled_worker", unit_id: stalled.unit_id, worker: stalled.worker,
        action_id: stalled.action_id, detail: stalled.detail, decisions: decisionsOf(stalled.unit_id, (submit) => submit.kind === "retry" && submit.worker === stalled.worker) })),
      ...unit.awaiting.map((awaiting): InspectAttention => ({ kind: "awaiting_review", unit_id: awaiting.unit_id, review: awaiting.review,
        target: awaiting.target, decisions: decisionsOf(awaiting.unit_id, (submit) => submit.kind === "review" && submit.review === awaiting.review) })),
    ]),
    artifacts: views.flatMap((view) => view.artifacts),
    attempts: selectAttemptViews(read.attempts),
    events: events.map((event) => ({ id: event.id, unit_id: event.unit_id, kind: event.payload.kind, writer: event.writer, created_at: event.created_at })) };
}
