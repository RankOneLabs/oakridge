import { describe, expect, it } from "vitest";
import { renderHook, act } from "@testing-library/react";

import { useInFlightAssistant } from "./useInFlightAssistant";
import type { EnvelopeEvent } from "../types";

function ev(id: number, type: string, payload: unknown): EnvelopeEvent {
  return { id, type, ts: "2026-05-25T00:00:00.000Z", payload };
}

// CC stream_event helpers
function streamEv(id: number, event: unknown): EnvelopeEvent {
  return ev(id, "stream_event", { event });
}
function msgStart(id: number): EnvelopeEvent {
  return streamEv(id, { type: "message_start", message: { usage: { output_tokens: 0 } } });
}
function cbStart(id: number, index: number, block: unknown): EnvelopeEvent {
  return streamEv(id, { type: "content_block_start", index, content_block: block });
}
function cbDelta(id: number, index: number, delta: unknown): EnvelopeEvent {
  return streamEv(id, { type: "content_block_delta", index, delta });
}

// Codex assistant_delta helper
function delta(id: number, itemId: string, text: string): EnvelopeEvent {
  return ev(id, "assistant_delta", { type: "assistant_delta", threadId: "t1", turnId: "turn-1", itemId, delta: text });
}

describe("useInFlightAssistant — CC stream_event path", () => {
  it("builds a text block from content_block_start + content_block_delta sequence", () => {
    const events = [
      msgStart(1),
      cbStart(2, 0, { type: "text", text: "" }),
      cbDelta(3, 0, { type: "text_delta", text: "Hello" }),
      cbDelta(4, 0, { type: "text_delta", text: " world" }),
    ];
    const { result } = renderHook(() => useInFlightAssistant(events, "sid-1"));
    expect(result.current).not.toBeNull();
    expect(result.current!.blocks).toHaveLength(1);
    expect(result.current!.blocks[0]).toEqual({ type: "text", text: "Hello world" });
  });

  it("builds a thinking block from content_block_start + thinking_delta", () => {
    const events = [
      msgStart(1),
      cbStart(2, 0, { type: "thinking", thinking: "" }),
      cbDelta(3, 0, { type: "thinking_delta", thinking: "I'm thinking…" }),
    ];
    const { result } = renderHook(() => useInFlightAssistant(events, "sid-1"));
    expect(result.current!.blocks[0]).toEqual({ type: "thinking", thinking: "I'm thinking…" });
  });

  it("clears in-flight state when final assistant event arrives", () => {
    const base = [
      msgStart(1),
      cbStart(2, 0, { type: "text", text: "" }),
      cbDelta(3, 0, { type: "text_delta", text: "Hello" }),
    ];
    const { result, rerender } = renderHook(
      ({ evts }: { evts: EnvelopeEvent[] }) => useInFlightAssistant(evts, "sid-1"),
      { initialProps: { evts: base } },
    );
    expect(result.current).not.toBeNull();

    act(() => {
      rerender({
        evts: [...base, ev(4, "assistant", { message: { content: [{ type: "text", text: "Hello" }] } })],
      });
    });
    expect(result.current).toBeNull();
  });

  it("clears in-flight state when result event arrives (turn boundary reset)", () => {
    const base = [
      msgStart(1),
      cbStart(2, 0, { type: "text", text: "" }),
      cbDelta(3, 0, { type: "text_delta", text: "Hi" }),
    ];
    const { result, rerender } = renderHook(
      ({ evts }: { evts: EnvelopeEvent[] }) => useInFlightAssistant(evts, "sid-1"),
      { initialProps: { evts: base } },
    );
    expect(result.current).not.toBeNull();

    act(() => {
      rerender({ evts: [...base, ev(4, "result", { subtype: "success" })] });
    });
    expect(result.current).toBeNull();
  });
});

describe("useInFlightAssistant — assistant_delta (Codex) path", () => {
  it("accumulates delta text into a single text block per item_id", () => {
    const events = [
      delta(1, "item-a", "Hello"),
      delta(2, "item-a", " there"),
    ];
    const { result } = renderHook(() => useInFlightAssistant(events, "sid-2"));
    expect(result.current).not.toBeNull();
    expect(result.current!.blocks).toHaveLength(1);
    expect(result.current!.blocks[0]).toEqual({ type: "text", text: "Hello there" });
  });

  it("creates separate text blocks for distinct item_ids", () => {
    const events = [
      delta(1, "item-a", "foo"),
      delta(2, "item-b", "bar"),
    ];
    const { result } = renderHook(() => useInFlightAssistant(events, "sid-2"));
    expect(result.current!.blocks).toHaveLength(2);
  });

  it("clears in-flight state when final assistant event arrives", () => {
    const base = [delta(1, "item-a", "Hello")];
    const { result, rerender } = renderHook(
      ({ evts }: { evts: EnvelopeEvent[] }) => useInFlightAssistant(evts, "sid-2"),
      { initialProps: { evts: base } },
    );
    expect(result.current).not.toBeNull();

    act(() => {
      rerender({
        evts: [...base, ev(2, "assistant", { message: { role: "assistant", content: "Hello" } })],
      });
    });
    expect(result.current).toBeNull();
  });

  it("ignores assistant_delta events with missing itemId or delta", () => {
    const events = [
      ev(1, "assistant_delta", { type: "assistant_delta", turnId: "t1" }),
    ];
    const { result } = renderHook(() => useInFlightAssistant(events, "sid-2"));
    expect(result.current).toBeNull();
  });
});

describe("useInFlightAssistant — CC and Codex paths don't interfere", () => {
  it("CC stream reset does not affect a subsequent Codex delta turn", () => {
    const firstTurn = [
      msgStart(1),
      cbStart(2, 0, { type: "text", text: "" }),
      cbDelta(3, 0, { type: "text_delta", text: "CC text" }),
      ev(4, "assistant", { message: { content: [{ type: "text", text: "CC text" }] } }),
    ];
    const secondTurn = [...firstTurn, delta(5, "item-a", "Codex text")];
    const { result, rerender } = renderHook(
      ({ evts }: { evts: EnvelopeEvent[] }) => useInFlightAssistant(evts, "sid-3"),
      { initialProps: { evts: secondTurn } },
    );
    expect(result.current).not.toBeNull();
    expect(result.current!.blocks[0]).toEqual({ type: "text", text: "Codex text" });
  });
});
