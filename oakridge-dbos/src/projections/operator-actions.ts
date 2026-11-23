import type { RecordedFeedbackDisposition, RunRead } from "../storage/read-store";

export type ActionHistoryEntry = RecordedFeedbackDisposition;

export function selectOperatorActions(read: RunRead): readonly ActionHistoryEntry[] {
  const actors = new Map(read.decisions.map((decision) => [decision.id as string,
    decision.actor?.kind === "operator" ? decision.actor.subject : null]));
  return (read.feedback_dispositions ?? []).map((fact) => ({
    ...fact, actor: fact.actor ?? actors.get(fact.decision_id) ?? null,
  }));
}
