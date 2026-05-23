import {
  extractResultUsage,
  type Session,
} from "../../core/session/session";

/**
 * CC-specific stdout classifier. Called by Session.spawn()'s stdout pump
 * for every parsed line, after core has already emitted the raw event to
 * subscribers and JSONL.
 *
 * Three CC events carry adapter-relevant metadata:
 *
 * - `system + subtype:"init"`: carries the CC subprocess's `session_id`,
 *   which the operator's PreToolUse gate stamps on every approval request.
 *   We capture it via session.observeRuntimeSessionId(), which writes a
 *   `cc_session_id_observed` event to JSONL (so resume survives a server
 *   restart) and notifies the manager (so the gate can map back to this
 *   session). The same event also carries the model CC resolved at spawn,
 *   forwarded via session.observeRuntimeModel() — but only when no runtime
 *   model has been observed yet, so a stray re-init (CC theoretically can
 *   re-emit on adapter reconnect) cannot clobber a value already updated
 *   from a later assistant turn. First-wins; assistant wins thereafter.
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

// Named shapes for the CC raw event variants this classifier inspects.
// Each variant lists only the fields we read; everything else on the raw
// event is ignored. Values are typed `unknown` because rawEvent comes from
// JSON.parse — the runtime `typeof` checks below remain authoritative.
type CcSystemInitEvent = {
  type: "system";
  subtype: "init";
  session_id?: unknown;
  model?: unknown;
};

type CcAssistantEvent = {
  type: "assistant";
  message?: { model?: unknown };
};

type CcResultEvent = {
  type: "result";
  usage?: unknown;
  stop_reason?: unknown;
};

export async function classifyCcEvent(
  rawEvent: unknown,
  session: Session,
): Promise<void> {
  if (!rawEvent || typeof rawEvent !== "object") return;
  // Read just the discriminant fields first; once they pin down a variant,
  // cast to the named type and use typed property access below.
  const head = rawEvent as { type?: unknown; subtype?: unknown };

  if (head.type === "system" && head.subtype === "init") {
    const evt = rawEvent as CcSystemInitEvent;
    if (typeof evt.session_id === "string") {
      await session.observeRuntimeSessionId(evt.session_id);
    }
    // First-wins on init: only seed observedModel when no runtime model has
    // been observed yet. CC normally fires init exactly once before any
    // assistant message, so under steady-state this is equivalent to
    // "always update from init"; the guard exists so an out-of-order or
    // re-emitted init can't overwrite a value already updated by a later
    // assistant turn (matches the documented update policy).
    if (
      typeof evt.model === "string" &&
      session.currentObservedModel === null
    ) {
      await session.observeRuntimeModel(evt.model);
    }
    return;
  }

  if (head.type === "assistant") {
    const evt = rawEvent as CcAssistantEvent;
    const model = evt.message?.model;
    if (typeof model === "string") {
      await session.observeRuntimeModel(model);
    }
    return;
  }

  if (head.type === "result") {
    const evt = rawEvent as CcResultEvent;
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
