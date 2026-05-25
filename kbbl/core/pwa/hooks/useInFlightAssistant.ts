import { useState, useEffect, useRef } from "react";

import type { EnvelopeEvent, InFlightAssistant, InFlightAccum } from "../types";
import { parseIsoMs } from "../lib/time";

function emptyAccum(sid: string): InFlightAccum {
  return {
    blocks: new Map(),
    partialToolInputs: new Map(),
    codexDeltaItems: new Map(),
    outputTokens: null,
    startedAtMs: null,
    lastEventIdx: -1,
    sid,
  };
}

function snapshotAccum(a: InFlightAccum): InFlightAssistant | null {
  if (a.blocks.size === 0 && a.codexDeltaItems.size === 0 && a.outputTokens === null) return null;
  const ordered = [...a.blocks.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([, v]) => v);
  // Append Codex delta text blocks in insertion order (one block per item_id).
  for (const [, text] of a.codexDeltaItems) {
    if (text.length > 0) ordered.push({ type: "text", text });
  }
  return {
    blocks: ordered,
    outputTokens: a.outputTokens,
    startedAt: a.startedAtMs ?? Date.now(),
  };
}

export function useInFlightAssistant(
  events: EnvelopeEvent[],
  sid: string,
): InFlightAssistant | null {
  const [value, setValue] = useState<InFlightAssistant | null>(null);
  const accumRef = useRef<InFlightAccum>(emptyAccum(sid));

  useEffect(() => {
    const a = accumRef.current;
    if (a.sid !== sid) {
      accumRef.current = emptyAccum(sid);
      setValue(null);
      return;
    }
    let dirty = false;
    for (let i = a.lastEventIdx + 1; i < events.length; i++) {
      const evt = events[i];
      // Turn boundary: clear so the canonical AssistantRow takes over once
      // the final assistant event lands, and reset for the next user turn
      // when a `result` arrives.
      if (evt.type === "result" || evt.type === "assistant") {
        if (
          a.blocks.size > 0 ||
          a.codexDeltaItems.size > 0 ||
          a.outputTokens !== null ||
          a.startedAtMs !== null
        ) {
          a.blocks = new Map();
          a.partialToolInputs = new Map();
          a.codexDeltaItems = new Map();
          a.outputTokens = null;
          a.startedAtMs = null;
          dirty = true;
        }
        continue;
      }
      // Codex assistant_delta: append delta text to a text block keyed by
      // item_id. Parallel to the CC stream_event branch — does not translate
      // Codex deltas into fake CC events; each runtime streams natively.
      if (evt.type === "assistant_delta") {
        const p = evt.payload as { itemId?: unknown; delta?: unknown };
        if (typeof p.itemId !== "string" || typeof p.delta !== "string") continue;
        if (a.startedAtMs === null) {
          const ms = parseIsoMs(evt.ts);
          if (ms !== null) { a.startedAtMs = ms; dirty = true; }
        }
        const prev = a.codexDeltaItems.get(p.itemId) ?? "";
        a.codexDeltaItems.set(p.itemId, prev + p.delta);
        dirty = true;
        continue;
      }
      if (evt.type !== "stream_event") continue;
      // Capture the turn-start timestamp on the first stream_event of the
      // current turn (turn-boundary reset above clears startedAtMs). Doing
      // this at the top of the stream_event branch — instead of only inside
      // the message_start handler — covers two edge cases: a late-joining
      // SSE viewer who missed message_start, and a stream that opens with
      // content_block_start (CC has been observed to do this with cached
      // prefixes). It also keeps the start-time scoped to the current turn,
      // so a malformed ts can't snap the elapsed counter to a historical
      // event from a previous turn.
      if (a.startedAtMs === null) {
        const ms = parseIsoMs(evt.ts);
        if (ms !== null) {
          a.startedAtMs = ms;
          dirty = true;
        }
      }
      const wrapped = evt.payload as { event?: unknown };
      const e = wrapped?.event as
        | {
            type?: string;
            index?: number;
            message?: { usage?: { output_tokens?: unknown } };
            content_block?: {
              type?: string;
              id?: unknown;
              name?: unknown;
              input?: unknown;
              text?: unknown;
              thinking?: unknown;
            };
            delta?: {
              type?: string;
              text?: unknown;
              thinking?: unknown;
              partial_json?: unknown;
            };
            usage?: { output_tokens?: unknown };
          }
        | undefined;
      if (!e || typeof e.type !== "string") continue;
      if (e.type === "message_start") {
        const ot = e.message?.usage?.output_tokens;
        if (typeof ot === "number") a.outputTokens = ot;
        dirty = true;
      } else if (e.type === "content_block_start") {
        const idx = e.index;
        const cb = e.content_block;
        if (typeof idx !== "number" || !cb || typeof cb.type !== "string") {
          continue;
        }
        if (cb.type === "text") {
          a.blocks.set(idx, {
            type: "text",
            text: typeof cb.text === "string" ? cb.text : "",
          });
          dirty = true;
        } else if (cb.type === "thinking") {
          a.blocks.set(idx, {
            type: "thinking",
            thinking: typeof cb.thinking === "string" ? cb.thinking : "",
          });
          dirty = true;
        } else if (cb.type === "tool_use") {
          a.blocks.set(idx, {
            type: "tool_use",
            id: typeof cb.id === "string" ? cb.id : "",
            name: typeof cb.name === "string" ? cb.name : "",
            input: cb.input ?? {},
          });
          dirty = true;
        }
      } else if (e.type === "content_block_delta") {
        const idx = e.index;
        const d = e.delta;
        if (typeof idx !== "number" || !d || typeof d.type !== "string") {
          continue;
        }
        let block = a.blocks.get(idx);
        if (!block) {
          // Late-join: an SSE reconnect can land us mid-stream after the
          // matching content_block_start has already been delivered to
          // earlier subscribers. Synthesize an empty block of the right
          // kind from the delta type so the partial UI keeps rendering
          // instead of silently dropping every chunk.
          if (d.type === "text_delta") block = { type: "text", text: "" };
          else if (d.type === "thinking_delta") {
            block = { type: "thinking", thinking: "" };
          } else if (d.type === "input_json_delta") {
            block = { type: "tool_use", id: "", name: "", input: {} };
          } else continue;
          a.blocks.set(idx, block);
        }
        if (
          d.type === "text_delta" &&
          block.type === "text" &&
          typeof d.text === "string"
        ) {
          a.blocks.set(idx, { ...block, text: block.text + d.text });
          dirty = true;
        } else if (
          d.type === "thinking_delta" &&
          block.type === "thinking" &&
          typeof d.thinking === "string"
        ) {
          a.blocks.set(idx, {
            ...block,
            thinking: block.thinking + d.thinking,
          });
          dirty = true;
        } else if (
          d.type === "input_json_delta" &&
          block.type === "tool_use" &&
          typeof d.partial_json === "string"
        ) {
          // Buffer the partial-JSON chunks per block index. JSON.parse
          // only succeeds once the chunks accumulate to a complete value,
          // so for the first several deltas we silently keep accumulating
          // and the live panel just shows the tool name. Once parseable,
          // the parsed object replaces the block's input — previewToolInput
          // can now show e.g. "Bash" + "npm test" before the turn closes.
          //
          // Only attempt parse when the buffer ends with `}` or `]` — the
          // outermost terminator of a JSON object or array value, which is
          // what tool inputs always are. Without this gate, every chunk
          // re-parses the full accumulated string (O(N×M)); large Write
          // contents would noticeably stall the UI thread mid-stream.
          const prev = a.partialToolInputs.get(idx) ?? "";
          const next = prev + d.partial_json;
          a.partialToolInputs.set(idx, next);
          const last = next.charCodeAt(next.length - 1);
          if (last === 0x7d /* } */ || last === 0x5d /* ] */) {
            try {
              a.blocks.set(idx, { ...block, input: JSON.parse(next) });
            } catch {
              // brace inside a string value, not the outermost close;
              // keep accumulating
            }
          }
          dirty = true;
        }
      } else if (e.type === "message_delta") {
        const ot = e.usage?.output_tokens;
        if (typeof ot === "number") {
          a.outputTokens = ot;
          dirty = true;
        }
      }
    }
    a.lastEventIdx = events.length - 1;
    if (dirty) setValue(snapshotAccum(a));
  }, [events, sid]);

  return value;
}

// Timestamp of the first event after the most recent `result` — drives the
// elapsed counter even before CC's first stream_event arrives. Returns null
// for a malformed ts so NaN doesn't reach the elapsed math.
export function turnStartedAtMs(
  events: EnvelopeEvent[],
  awaitingResult: boolean,
): number | null {
  if (!awaitingResult) return null;
  let lastResultIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "result") {
      lastResultIdx = i;
      break;
    }
  }
  for (let i = lastResultIdx + 1; i < events.length; i++) {
    const e = events[i];
    if (
      e.type === "user" ||
      e.type === "assistant" ||
      e.type === "stream_event" ||
      e.type === "assistant_delta"
    ) {
      return parseIsoMs(e.ts);
    }
  }
  return null;
}
