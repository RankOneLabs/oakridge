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
 *   token counts. The latest usage is what the PWA's Resume cost preview
 *   reads — important on Claude Max where a resume re-ingests parent
 *   context against the 5-hour rate-limit window.
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
    if (usage) session.setLastResultUsage(usage);
    return;
  }
}
