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
 *   session). The same event also carries the model CC resolved at spawn,
 *   forwarded via session.observeRuntimeModel().
 *
 * - `assistant`: carries the model that produced this turn at
 *   `message.model`. Forwarded via session.observeRuntimeModel() so a
 *   subagent firing under a different model is visible on the snapshot
 *   (last-wins, idempotent on the steady-state same-model case).
 *
 * - `result`: the per-turn completion event, carrying a `usage` block of
 *   token counts. We hand it off via session.observeTurnEnd(), which
 *   updates `lastResultUsage` for the Resume cost preview, appends a
 *   UsageObservation to the in-memory ring buffer, and emits a
 *   `usage_observation` envelope event into JSONL. Cache-vs-idle bucketing
 *   in Phase 6 reads from the latter. CC no longer carries a top-level
 *   model on result events — observedModel is sourced from system+init
 *   and assistant instead.
 */
export async function classifyCcEvent(
  rawEvent: unknown,
  session: Session,
): Promise<void> {
  if (!rawEvent || typeof rawEvent !== "object") return;
  const evt = rawEvent as Record<string, unknown>;

  if (evt.type === "system" && evt.subtype === "init") {
    if (typeof evt.session_id === "string") {
      await session.observeRuntimeSessionId(evt.session_id);
    }
    if (typeof evt.model === "string") {
      await session.observeRuntimeModel(evt.model);
    }
    return;
  }

  if (evt.type === "assistant") {
    const message = evt.message;
    if (message && typeof message === "object") {
      const model = (message as { model?: unknown }).model;
      if (typeof model === "string") {
        await session.observeRuntimeModel(model);
      }
    }
    return;
  }

  if (evt.type === "result") {
    const usage = extractResultUsage(evt);
    if (!usage) return;
    await session.observeTurnEnd({ usage, model: null });

    // Forward to compactor for soft/hard threshold scheduling.
    // session_tokens = input + cache_read + cache_creation. Output is
    // excluded because it'll be input on the next turn.
    // observeAssistantTurn is a no-op unless stop_reason === "end_turn"
    // (Compactor enforces). was_subagent_synthesis is hard-coded to
    // false in v0; subagent detection is punted.
    const stopReason =
      typeof evt.stop_reason === "string" ? evt.stop_reason : "";
    if (session.compactor) {
      session.compactor.observeAssistantTurn({
        stop_reason: stopReason,
        session_tokens:
          usage.input_tokens +
          (usage.cache_read_input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0),
        was_subagent_synthesis: false,
      });
    }
    return;
  }
}
