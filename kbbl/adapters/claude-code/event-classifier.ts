import {
  extractResultUsage,
  type Session,
} from "../../core/session/session";

/**
 * CC-specific stdout classifier. Called by Session.spawn()'s stdout pump
 * for every parsed line, after core has already emitted the raw event to
 * subscribers and JSONL.
 *
 * Two CC events carry adapter-relevant metadata:
 *
 * - `system + subtype:"init"`: carries the CC subprocess's `session_id`,
 *   which the operator's PreToolUse gate stamps on every approval request.
 *   We capture it via session.observeRuntimeSessionId(), which writes a
 *   `cc_session_id_observed` event to JSONL (so resume survives a server
 *   restart) and notifies the manager (so the gate can map back to this
 *   session).
 *
 * - `result`: the per-turn completion event, carrying a `usage` block of
 *   token counts plus the model id. We hand it off via
 *   session.observeTurnEnd(), which updates `lastResultUsage` for the
 *   Resume cost preview, appends a UsageObservation to the in-memory ring
 *   buffer, and emits a `usage_observation` envelope event into JSONL.
 *   Cache-vs-idle bucketing in Phase 6 reads from the latter.
 */
export async function classifyCcEvent(
  rawEvent: unknown,
  session: Session,
): Promise<void> {
  if (!rawEvent || typeof rawEvent !== "object") return;
  const evt = rawEvent as Record<string, unknown>;

  if (
    evt.type === "system" &&
    evt.subtype === "init" &&
    typeof evt.session_id === "string"
  ) {
    await session.observeRuntimeSessionId(evt.session_id);
    return;
  }

  if (evt.type === "result") {
    const usage = extractResultUsage(evt);
    if (!usage) return;
    const model = typeof evt.model === "string" ? evt.model : null;
    await session.observeTurnEnd({ usage, model });
    return;
  }
}
