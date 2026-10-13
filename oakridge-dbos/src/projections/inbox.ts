import type { RunId, UnitId } from "../domain/primitives";
import type { RunRead } from "../storage/read-store";
import { selectAttention, selectRunAttention } from "./attention";
import { selectUnitLabel } from "./unit-label";
import { isAsk, selectAvailableDecisions, type DecisionSubmit } from "./unit-view";

/**
 * v1 `InboxItem`, renamed per rescue spec §2.3. Items are derived from
 * attention across live runs, never read from `review_item` rows.
 */
export type InboxItem =
  | { readonly kind: "decision"; readonly run_id: RunId; readonly unit_id: UnitId; readonly unit_version: number; readonly key: string;
    readonly label: string; readonly consequence: string; readonly submit: DecisionSubmit;
    /** The awaiting review's prompt, rendered with its resolved inputs; null for a retry. */
    readonly prompt: string | null }
  | { readonly kind: "wait"; readonly run_id: RunId; readonly unit_id: UnitId; readonly unit_version: number; readonly reason: string; readonly label: string }
  | { readonly kind: "diagnostic"; readonly run_id: RunId; readonly unit_id: UnitId; readonly unit_version: number; readonly detail: string };

export interface InboxPage {
  readonly cursor: readonly { readonly unit_id: UnitId; readonly version: number }[];
  readonly items: readonly InboxItem[];
  readonly next_cursor: string | null;
}
/** Review work and diagnostics from the inbox projection. */
export type ReviewInbox = InboxPage;

/** A run's inbox items, unit by unit: each decision that asks for the operator, a diagnostic per stalled worker, and the unit's wait. */
export function selectRunInboxItems(read: RunRead): readonly InboxItem[] {
  return selectRunAttention(read).flatMap((attention) => {
    const unit = read.units.find((candidate) => candidate.id === attention.unit_id);
    if (!unit) return [];
    const base = { run_id: unit.run_id, unit_id: unit.id, unit_version: unit.version };
    const decisions = selectAvailableDecisions(read, unit, attention).map((item) => item.definition).filter(isAsk)
      .map((decision): InboxItem => ({ ...base, kind: "decision", key: decision.key, label: decision.label, consequence: decision.consequence,
        submit: decision.submit, prompt: decision.submit.kind === "review" ? attention.awaiting.find((awaiting) =>
          decision.submit.kind === "review" && awaiting.review === decision.submit.review)?.prompt ?? null : null }));
    const diagnostics = attention.stalled.map((stalled): InboxItem => ({ ...base, kind: "diagnostic", detail: `${stalled.worker} failed: ${stalled.detail}` }));
    const line = attention.stalled.length === 0 ? selectAttention(attention, read) : null;
    const wait: InboxItem[] = line?.kind === "wait" ? [{ ...base, kind: "wait", reason: line.reason, label: selectUnitLabel(unit, read.definition.workflow) }] : [];
    return [...decisions, ...diagnostics, ...wait];
  });
}

export function selectInboxPage(runs: readonly RunRead[], next_cursor: string | null): InboxPage {
  const items = runs.flatMap(selectRunInboxItems);
  const units = new Map(items.map((item) => [item.unit_id, item.unit_version]));
  return { cursor: [...units].map(([unit_id, version]) => ({ unit_id, version })), items, next_cursor };
}
