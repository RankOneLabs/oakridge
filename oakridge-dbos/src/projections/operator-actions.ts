import type { Writer } from "../core-client/core-types";
import type { Disposition } from "../domain/adjudication";
import type { ActionSource } from "../domain/assessment";
import type { UnitId } from "../domain/primitives";
import type { RunRead } from "../storage/read-store";
import { selectRevisionDecision } from "./unit-view";

interface ActionHistoryContext {
  readonly unit_id: UnitId;
  readonly assessment_revision_id: string;
  readonly review: string;
  readonly decision: string;
  readonly decision_id: string;
  readonly actor: Writer | null;
  readonly created_at: Date;
}

export type ActionHistoryEntry =
  | (ActionHistoryContext & {
    readonly kind: "assessed";
    readonly action_id: string;
    readonly disposition: Disposition;
    readonly original_text: string;
    readonly final_text: string | null;
    readonly source: ActionSource;
    readonly reason: string | null;
  })
  | (ActionHistoryContext & {
    readonly kind: "added";
    readonly action_id: string;
    readonly final_text: string;
    readonly source: ActionSource;
    readonly reason: string | null;
  });

export function selectOperatorActions(read: RunRead): readonly ActionHistoryEntry[] {
  return [...read.decisions]
    .sort((left, right) => left.created_at.getTime() - right.created_at.getTime() || left.id.localeCompare(right.id))
    .flatMap((row): ActionHistoryEntry[] => {
      const decision = selectRevisionDecision(read, row);
      if (decision.adjudication == null || decision.assessment_revision_id == null) return [];
      const context: ActionHistoryContext = {
        unit_id: row.unit_id,
        assessment_revision_id: decision.assessment_revision_id,
        review: decision.review,
        decision: decision.decision,
        decision_id: decision.id,
        actor: decision.actor ?? null,
        created_at: decision.created_at,
      };
      return [
        ...decision.adjudication.entries.filter(entry => entry.audience === "operator").map(entry => ({
          ...context, kind: "assessed" as const, action_id: entry.action_id, disposition: entry.disposition,
          original_text: entry.original_text, final_text: entry.final_text ?? null, source: entry.source, reason: entry.reason ?? null,
        })),
        ...decision.adjudication.added_actions.filter(entry => entry.audience === "operator").map(entry => ({
          ...context, kind: "added" as const, action_id: entry.action_id, final_text: entry.final_text,
          source: entry.source, reason: entry.reason ?? null,
        })),
      ];
    });
}
