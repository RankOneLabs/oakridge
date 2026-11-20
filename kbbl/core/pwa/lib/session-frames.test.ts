import { expect, it } from "vitest";
import { EMPTY_SESSION_LIVE_STATE, streamEpoch, transcriptItemId, transcriptSeq, type AgentMessageItem } from "../../acp/transcript-model";
import type { SessionEpochFrame, TurnKey, UiOpenTurn } from "../types";
import { applySessionFrame, EMPTY_SESSION_STREAM_STATE } from "./session-frames";

function message(index: number): AgentMessageItem {
  const seq = transcriptSeq(index);
  return { kind: "agent_message", seq, id: transcriptItemId(seq), message_id: null, text: "hello", is_streaming: true, is_replayed: false };
}

it("resets transcript, history metadata, live state, open turns and error on epoch", () => {
  const previous = { ...EMPTY_SESSION_STREAM_STATE, stream_epoch: streamEpoch("old"), items: [message(0)], stream_error: "offline" };
  const epoch: SessionEpochFrame = {
    kind: "epoch", stream_epoch: streamEpoch("new"), history_kind: "unavailable", expired: true,
    summary: null, unavailable_reason: "agent_history_unavailable", open_turns: [],
    session_state: { ...EMPTY_SESSION_LIVE_STATE, session_title: "new title" }, items: [], has_earlier: true, is_truncated: true,
  };
  const { kind, ...fields } = epoch;
  expect(applySessionFrame(previous, epoch)).toEqual({ ...fields, stream_error: null });
});

it("replaces an existing item in place and keeps other item instances", () => {
  const first = message(0);
  const second = message(1);
  const replacement = { ...second, text: "replacement" };
  const state = { ...EMPTY_SESSION_STREAM_STATE, items: [first, second] };
  const result = applySessionFrame(state, { kind: "item", item: replacement });
  expect(result.items[0]).toBe(first);
  expect(result.items[1]).toBe(replacement);
});

it("inserts newly received items by sequence", () => {
  const state = { ...EMPTY_SESSION_STREAM_STATE, items: [message(0), message(2)] };
  const result = applySessionFrame(state, { kind: "item", item: message(1) });
  expect(result.items.map((item) => item.seq)).toEqual([0, 1, 2]);
});

it("appends only the delta, updates streaming status and ignores unknown ids", () => {
  const item = message(0);
  const state = { ...EMPTY_SESSION_STREAM_STATE, items: [item] };
  const delta = { kind: "item_text", id: item.id, delta: " world", is_streaming: false } as const;
  expect(applySessionFrame(state, delta).items).toEqual([{ ...item, text: "hello world", is_streaming: false }]);
  expect(applySessionFrame(state, { ...delta, id: message(1).id })).toBe(state);
});

it("marks the matching open turn prompting and removes it on idle", () => {
  const turn: UiOpenTurn = { turnKey: "operator:a" as TurnKey, text: "a", source: "operator", status: "accepted", createdAt: "2026-01-01" };
  const other = { ...turn, turnKey: "operator:b" as TurnKey };
  const state = { ...EMPTY_SESSION_STREAM_STATE, open_turns: [turn, other] };
  const frame = { kind: "turn_state", turn_key: turn.turnKey, stop_reason: null, detail: null } as const;
  const prompting = applySessionFrame(state, { ...frame, state: "prompting" });
  expect(prompting.open_turns).toEqual([{ ...turn, status: "prompting" }, other]);
  expect(applySessionFrame(prompting, { ...frame, state: "idle" }).open_turns).toEqual([other]);
});
