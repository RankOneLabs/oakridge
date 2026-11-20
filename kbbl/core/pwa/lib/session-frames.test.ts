import { expect, it } from "vitest";
import { EMPTY_SESSION_LIVE_STATE, streamEpoch, transcriptItemId, transcriptSeq, type AgentMessageItem } from "../../acp/transcript-model";
import { INITIAL_SESSION_TRANSCRIPT_STATE, selectOrderedItems } from "../state/session-transcript-store";
import type { SessionEpochFrame, TurnKey, UiOpenTurn } from "../types";
import { applyEpochFrame, applyIncrementalFrames, prependPage } from "./session-frames";

function message(index: number): AgentMessageItem {
  const seq = transcriptSeq(index);
  return { kind: "agent_message", seq, id: transcriptItemId(seq), message_id: null, text: "hello", is_streaming: true, is_replayed: false };
}

const epoch: SessionEpochFrame = {
  kind: "epoch", stream_epoch: streamEpoch("new"), history_kind: "unavailable", expired: true,
  summary: null, unavailable_reason: "agent_history_unavailable", open_turns: [],
  session_state: { ...EMPTY_SESSION_LIVE_STATE, session_title: "new title" }, items: [], has_earlier: false, is_truncated: false,
};

const turn: UiOpenTurn = {
  turnKey: "operator:a" as TurnKey, text: "a", source: "operator", status: "accepted", createdAt: "2026-01-01",
};

it("resets transcript, history, flags, live state, open turns and error on epoch", () => {
  const previous = {
    ...applyEpochFrame({ ...epoch, stream_epoch: streamEpoch("old"), history_kind: "transcript", items: [message(0)], open_turns: [turn], has_earlier: true, is_truncated: true }),
    connection: { status: "connected", stream_error: "offline" } as const,
    is_loading_earlier: true,
  };
  const item = message(1);
  expect(applyEpochFrame({ ...epoch, items: [item] }, previous)).toEqual({
    ...INITIAL_SESSION_TRANSCRIPT_STATE,
    stream_epoch: epoch.stream_epoch,
    items_by_id: new Map([[item.id, item]]),
    ordered_ids: [item.id],
    session_state: epoch.session_state,
    connection: { status: "connected", stream_error: null },
    history: { kind: "unavailable", expired: true, summary: null, unavailable_reason: "agent_history_unavailable" },
    transcript_version: 2,
  });
});

it("replaces an existing item in place and keeps other item instances", () => {
  const [first, second, third] = [message(0), message(1), message(2)];
  const replacement = { ...second, text: "replacement" };
  const state = applyEpochFrame({ ...epoch, items: [first, second, third] });
  const result = applyIncrementalFrames(state, [{ kind: "item", item: replacement }]);
  const items = selectOrderedItems(result);
  expect(items[0]).toBe(first);
  expect(items[1]).toBe(replacement);
  expect(items[2]).toBe(third);
  expect(result.ordered_ids).toBe(state.ordered_ids);
});

it("inserts newly received items by sequence", () => {
  const state = applyEpochFrame({ ...epoch, items: [message(0), message(2)] });
  const result = applyIncrementalFrames(state, [{ kind: "item", item: message(1) }]);
  expect(selectOrderedItems(result).map((item) => item.seq)).toEqual([0, 1, 2]);
});

it("appends only the delta, updates streaming status and ignores unknown ids", () => {
  const item = message(0);
  const other = message(1);
  const state = applyEpochFrame({ ...epoch, items: [item, other] });
  const delta = { kind: "item_text", id: item.id, delta: " world", is_streaming: false } as const;
  const items = selectOrderedItems(applyIncrementalFrames(state, [delta]));
  expect(items[0]).toEqual({ ...item, text: "hello world", is_streaming: false });
  expect(items[1]).toBe(other);
  expect(applyIncrementalFrames(state, [{ ...delta, id: message(2).id }])).toBe(state);
});

it.each(["idle", "cancelled", "failed", "unknown"] as const)("removes the matching open turn on %s", (terminal) => {
  const other = { ...turn, turnKey: "operator:b" as TurnKey };
  const state = applyEpochFrame({ ...epoch, open_turns: [turn, other] });
  const frame = { kind: "turn_state", turn_key: turn.turnKey, stop_reason: null, detail: null } as const;
  const prompting = applyIncrementalFrames(state, [{ ...frame, state: "prompting" }]);
  expect(prompting.open_turns).toEqual([{ ...turn, status: "prompting" }, other]);
  expect(applyIncrementalFrames(prompting, [{ ...frame, state: terminal }]).open_turns).toEqual([other]);
});

it("prepends earlier rows in sequence order and retains existing entries with duplicate IDs", () => {
  const current = message(2);
  const state = applyEpochFrame({ ...epoch, items: [current, message(3)] });
  const result = prependPage(state, [message(0), message(1), { ...current, text: "older copy" }]);
  expect(selectOrderedItems(result).map((item) => item.seq)).toEqual([0, 1, 2, 3]);
  expect(result.items_by_id.get(current.id)).toBe(current);
});
