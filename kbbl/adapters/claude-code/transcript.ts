// Transcript → envelope-event transform.
//
// In PTY (subscription-billing) mode CC no longer streams stream-json to
// stdout, so the parser that once produced `user`/`assistant`/`result`
// envelope events has no input — the Conversation view goes dark (sent
// messages never reconcile, replies never render). CC does, however, write a
// complete JSONL transcript to disk at `transcript_path`. This module maps
// those on-disk entries back into the SAME envelope shapes the PWA already
// consumes, restoring the pre-PTY contract with no frontend changes.
//
// This file is the PURE transform half (one transcript line → zero or more
// envelope events). The IO half (watching/reading the file) lives in
// transcript-tailer.ts.

import type { ResultUsage } from "../../core/session/types";

/**
 * A content block as CC writes it to the transcript (Anthropic message shape).
 * The transform passes blocks through opaquely — it never inspects block
 * internals — so `unknown` is deliberate: the PWA re-narrows them against its
 * own ContentBlock union at the render boundary.
 */
export type TranscriptContentBlock = unknown;

export interface TranscriptUserMessage {
  role: "user";
  // A typed prompt is a string; tool results come back as a block array.
  content: string | TranscriptContentBlock[];
}

export interface TranscriptAssistantMessage {
  role: "assistant";
  content: TranscriptContentBlock[];
  id?: string;
  model?: string;
  stop_reason?: string | null;
  // Anthropic usage carries many fields; we narrow to the four ResultUsage
  // keys the metrics selector reads and ignore the rest.
  usage?: Partial<ResultUsage> & Record<string, unknown>;
}

export interface TranscriptUserEntry {
  type: "user";
  uuid: string;
  isSidechain?: boolean;
  /**
   * Provenance CC stamps on the user row. `origin.kind === "channel"` marks a
   * row CC injected from a kbbl channel push (our send() path) — i.e. the echo
   * of operator input that core has ALREADY synthesized at send time
   * (synthesizeUserInputEvents). The transform skips those (see
   * transcriptEntryToEvents) so the operator's message renders once, as the
   * clean synthesized text rather than CC's raw `<channel>…</channel>` wrapper.
   * Tool-result user rows and any directly-typed input carry a different origin
   * and flow through normally.
   */
  origin?: { kind?: string; server?: string };
  message: TranscriptUserMessage;
}

export interface TranscriptAssistantEntry {
  type: "assistant";
  uuid: string;
  isSidechain?: boolean;
  message: TranscriptAssistantMessage;
}

/**
 * A transcript line. We model only the two variants we map; every other
 * `type` CC writes (`mode`, `permission-mode`, `attachment`, `ai-title`,
 * `last-prompt`, `file-history-snapshot`, …) is a recognized skip, carried as
 * the open `OtherEntry` arm rather than treated as malformed.
 */
export type TranscriptEntry =
  | TranscriptUserEntry
  | TranscriptAssistantEntry
  | { type: string; uuid?: string; isSidechain?: boolean };

/** Envelope event input — `(type, payload)` handed straight to `session.emit`. */
export interface EmittedEvent {
  type: "user" | "assistant" | "result";
  payload: unknown;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Narrow a JSON-parsed transcript line into a TranscriptEntry. Returns null
 * for anything without a string `type` — a malformed line, not a known skip.
 * Known-but-unmapped entry types return as the open arm and are dropped later.
 */
export function parseTranscriptEntry(raw: unknown): TranscriptEntry | null {
  if (!isObject(raw) || typeof raw.type !== "string") return null;

  if (raw.type === "user" || raw.type === "assistant") {
    const message = raw.message;
    if (!isObject(message) || message.role !== raw.type) {
      // A user/assistant line whose message is missing or mis-roled is
      // malformed; skip rather than emit a half-formed bubble.
      return null;
    }
    const content = message.content;
    const contentOk =
      raw.type === "user"
        ? typeof content === "string" || Array.isArray(content)
        : Array.isArray(content);
    if (!contentOk) return null;
  }

  return raw as TranscriptEntry;
}

/**
 * Project the Anthropic usage bag down to the four ResultUsage fields. Always
 * returns a fully-numeric ResultUsage — a missing or partial usage bag yields
 * zeros, never `undefined` — so the synthesized result payload never violates
 * the numeric-field contract downstream metrics consumers rely on.
 */
export function projectUsage(
  usage: TranscriptAssistantMessage["usage"],
): ResultUsage {
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  return {
    input_tokens: num(usage?.input_tokens),
    output_tokens: num(usage?.output_tokens),
    cache_creation_input_tokens: num(usage?.cache_creation_input_tokens),
    cache_read_input_tokens: num(usage?.cache_read_input_tokens),
  };
}

/**
 * Map one transcript entry to the envelope events it should emit.
 *
 * - sidechain (subagent-internal) entries → skip; the SubagentStart/Stop hooks
 *   already mark that activity, and rendering nested turns inline is out of v1.
 * - `user` → a `user` event carrying the message verbatim. String content is
 *   the typed prompt that reconciles the operator's optimistic bubble; block
 *   content is a tool_result, which the EventList renders as it did pre-PTY.
 * - `assistant` → an `assistant` event carrying the message verbatim. CC writes
 *   one transcript line PER content block (all sharing the message id/usage),
 *   so a turn surfaces as separate thinking/text/tool_use rows — the same way
 *   the stream-json era rendered them.
 * - the final assistant message of an operator turn (`stop_reason: "end_turn"`)
 *   additionally emits a synthesized `result` event. This is what clears the
 *   PWA thinking indicator and feeds the metrics strip. `end_turn` is the only
 *   stop reason that means "model is done responding" (tool_use means the turn
 *   continues), so exactly one result is emitted per operator turn.
 *
 * Token usage rides along on the result; cost/duration are absent (CC's own
 * result line — which carried them — does not exist in PTY mode), so the cost
 * chip stays at zero. Tokens are the metric that matters for the soak.
 */
export function transcriptEntryToEvents(raw: unknown): EmittedEvent[] {
  const entry = parseTranscriptEntry(raw);
  if (entry === null) return [];
  if (entry.isSidechain === true) return [];

  if (entry.type === "user") {
    const userEntry = entry as TranscriptUserEntry;
    // Channel-origin user rows are CC's echo of operator input that core
    // already synthesized at send() time (synthesizeUserInputEvents). Emitting
    // one here would render the operator's message twice — and in CC's raw
    // `<channel source=…>…</channel>` wrapper rather than the clean text. Skip
    // them; the synthesized event is the single source for operator prompts.
    // Tool-result user rows (block content) carry no channel origin and still
    // flow through.
    if (userEntry.origin?.kind === "channel") return [];
    return [
      { type: "user", payload: { type: "user", message: userEntry.message } },
    ];
  }

  if (entry.type === "assistant") {
    const { message } = entry as TranscriptAssistantEntry;
    const events: EmittedEvent[] = [
      { type: "assistant", payload: { type: "assistant", message } },
    ];
    if (message.stop_reason === "end_turn") {
      // Carry stop_reason + content (the assistant message's blocks) onto the
      // synthesized result, matching the legacy CC result-event shape. Internal
      // consumers depend on both: extractCompactMarkdown filters on
      // stop_reason === "end_turn" and concatenates the text blocks of
      // `content`, and the CC classifier reads stop_reason + usage to drive
      // observeTurnEnd / compactor scheduling. usage rides along for metrics.
      events.push({
        type: "result",
        payload: {
          type: "result",
          stop_reason: "end_turn",
          content: message.content,
          usage: projectUsage(message.usage),
        },
      });
    }
    return events;
  }

  return [];
}
