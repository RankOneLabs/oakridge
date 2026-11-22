import type { AttemptRecord, ArtifactRevisionRecord } from "../storage/schema-records";
import { attemptKey } from "./usage-attribution";
export type ReworkAttempt = Pick<AttemptRecord, "action_id" | "seq" | "cause" | "created_at">;
export function classifyRework(attempts: readonly ReworkAttempt[], revisions: readonly Pick<ArtifactRevisionRecord, "id" | "by_action_id" | "by_seq">[]): Set<string> {
  const result = new Set<string>();
  // Fixed point also handles records supplied out of chronological order.
  let changed = true;
  while (changed) {
    changed = false;
    for (const attempt of attempts) {
      const cause = attempt.cause;
      const revision = cause.kind === "review_of" ? revisions.find((r) => r.id === cause.revision) : null;
      const publisher = revision?.by_action_id ? attempts.find((attempt) => attempt.action_id === revision.by_action_id && attempt.seq === revision.by_seq) : null;
      if ((cause.kind === "changes_requested" || cause.kind === "retry" || (publisher && result.has(attemptKey(publisher)))) && !result.has(attemptKey(attempt))) {
        result.add(attemptKey(attempt)); changed = true;
      }
    }
  }
  return result;
}
