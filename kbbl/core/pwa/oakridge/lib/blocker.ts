import type { OperatorBlockerAuthor, OperatorBlockerHistory } from "../operator-contracts/projections/history-view";
import type { OperatorWriter } from "../operator-contracts/core-client/core-types";
/** Who published a blocker revision: the worker attempt, or none for an operator edit. */
export function selectBlockerAuthor(author: OperatorBlockerAuthor | null): string {
  if (!author) return "Author not recorded";
  const session = author.session_id ? `, session ${author.session_id}` : "";
  return `${author.worker} (attempt ${author.attempt_seq}${session})`;
}
export function selectBlockerActor(actor: OperatorWriter | null): string {
  if (!actor) return "Actor not recorded";
  if (actor.kind === "operator") return `Operator ${actor.subject}`;
  if (actor.kind === "session") return `Session ${actor.session} (${actor.attempt})`;
  return actor.kind === "executor" ? `Executor ${actor.attempt}` : "Engine";
}
export const selectBlockerHistory = (blocker: OperatorBlockerHistory) => [...blocker.history].sort((a, b) =>
  (a.kind === "revision" ? a.revision.created_at : a.decision.created_at).localeCompare(b.kind === "revision" ? b.revision.created_at : b.decision.created_at));
