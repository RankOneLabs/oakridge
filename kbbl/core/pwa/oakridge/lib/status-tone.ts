import type { ChipTone } from "../../components/atoms/Chip";
import type { OperatorAttemptStatusKind, OperatorInboxItem } from "../operator-contracts";
import type { UnitBadgeStatus } from "./run-overview";

/**
 * What a status badge describes. Each operator status is a closed union mapped
 * exhaustively; only an artifact body's value is an open string, because its
 * vocabulary is whatever enum the pinned definition declares.
 */
export type StatusSubject =
  | { readonly kind: "unit"; readonly status: UnitBadgeStatus }
  /** `settled` is the inbox's own state for an item the operator already answered. */
  | { readonly kind: "inbox_item"; readonly status: OperatorInboxItem["kind"] | "settled" }
  | { readonly kind: "attempt"; readonly status: OperatorAttemptStatusKind }
  | { readonly kind: "artifact_value"; readonly status: string };

const selectUnitTone = (status: UnitBadgeStatus): ChipTone => {
  switch (status) {
    case "complete": return "success";
    case "cancelled": return "muted";
    case "attention": return "warning";
    case "running": return "info";
  }
};

const selectInboxItemTone = (status: OperatorInboxItem["kind"] | "settled"): ChipTone => {
  switch (status) {
    case "decision": return "warning";
    case "waiting": return "warning";
    case "stalled": return "danger";
    case "settled": return "muted";
  }
};

const selectAttemptTone = (status: OperatorAttemptStatusKind): ChipTone => {
  switch (status) {
    case "pending": return "muted";
    case "running": return "info";
    case "succeeded": return "success";
    case "failed": return "danger";
  }
};

/** The development definition's body enums (verdict, severity, requirement and review status). */
const ARTIFACT_VALUE_TONES: ReadonlyMap<string, ChipTone> = new Map<string, ChipTone>([
  ["pass", "success"], ["met", "success"], ["implementable", "success"], ["approved", "success"], ["merged", "success"],
  ["fail", "danger"], ["not_met", "danger"], ["blocked", "danger"], ["blocking", "danger"],
  ["pass_with_notes", "warning"], ["partial", "warning"], ["ambiguous", "warning"], ["changes_requested", "warning"],
  ["draft", "warning"], ["warning", "warning"],
  ["ready", "info"], ["info", "info"],
]);

export function selectStatusTone(subject: StatusSubject): ChipTone {
  switch (subject.kind) {
    case "unit": return selectUnitTone(subject.status);
    case "inbox_item": return selectInboxItemTone(subject.status);
    case "attempt": return selectAttemptTone(subject.status);
    case "artifact_value": return ARTIFACT_VALUE_TONES.get(subject.status) ?? "muted";
  }
}
