import type { RunId, UnitId } from "../domain/primitives";
import type { RunRead } from "../storage/read-store";
import { selectAttention, selectRunAttention } from "./attention";
import { selectUnitLabel } from "./unit-label";
import { isAsk, selectAvailableDecisions, type DecisionSubmit } from "./unit-view";

/**
 * What asks for the operator across live runs, derived from attention (never
 * read from `review_item` rows): each decision, a stalled worker, or a unit
 * parked on a review or a dependency.
 */
export type InboxItem =
  | { readonly kind: "decision"; readonly run_id: RunId; readonly unit_id: UnitId; readonly key: string; readonly label: string;
    readonly submit: DecisionSubmit;
    /** The awaiting review's prompt, rendered with its resolved inputs; null for a retry. */
    readonly prompt: string | null }
  | { readonly kind: "waiting"; readonly run_id: RunId; readonly unit_id: UnitId; readonly reason: string; readonly label: string }
  | { readonly kind: "stalled"; readonly run_id: RunId; readonly unit_id: UnitId; readonly detail: string };

export interface InboxPage { readonly items: readonly InboxItem[]; readonly next_cursor: string | null }

/** A run's inbox items, unit by unit: each decision that asks for the operator, each stalled worker, and the unit's wait. */
export function selectRunInboxItems(read: RunRead): readonly InboxItem[] {
  return selectRunAttention(read).flatMap((attention) => {
    const unit = read.units.find((candidate) => candidate.id === attention.unit_id);
    if (!unit) return [];
    const base = { run_id: unit.run_id, unit_id: unit.id };
    const decisions = selectAvailableDecisions(read, unit, attention).filter(isAsk)
      .map((decision): InboxItem => ({ ...base, kind: "decision", key: decision.key, label: decision.label, submit: decision.submit,
        prompt: decision.submit.kind === "review" ? attention.awaiting.find((awaiting) =>
          decision.submit.kind === "review" && awaiting.review === decision.submit.review)?.prompt ?? null : null }));
    const stalled = attention.stalled.map((worker): InboxItem => ({ ...base, kind: "stalled", detail: `${worker.worker} failed: ${worker.detail}` }));
    const line = attention.stalled.length === 0 ? selectAttention(attention, read) : null;
    const waiting: InboxItem[] = line?.kind === "waiting" ? [{ ...base, kind: "waiting", reason: line.reason, label: selectUnitLabel(unit, read.definition.workflow) }] : [];
    return [...decisions, ...stalled, ...waiting];
  });
}

export const selectInboxPage = (runs: readonly RunRead[], next_cursor: string | null): InboxPage =>
  ({ items: runs.flatMap(selectRunInboxItems), next_cursor });
