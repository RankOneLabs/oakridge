import { expect, test } from "bun:test";
import { buildEpochFrame, createSessionFrameEncoder, toWireFrames } from "./session-wire";
import { createTranscriptBuffer, foldUpdate } from "./transcript-fold";
import { EMPTY_SESSION_LIVE_STATE, streamEpoch, transcriptItemId, transcriptSeq, type AgentMessageItem, type StreamFrame } from "./transcript-model";
import type { AcpUiEvent, KbblSessionId, TurnKey, UiSessionHistory } from "./types";

const sid = "test" as KbblSessionId;
const epoch = streamEpoch("epoch");
const live_state = { ...EMPTY_SESSION_LIVE_STATE, session_title: "Active" };
const common = { sid, openTurns: [] };

function message(index: number): AgentMessageItem {
  const seq = transcriptSeq(index);
  return { kind: "agent_message", id: transcriptItemId(seq), seq, message_id: null, text: "full text", is_streaming: true, is_replayed: false };
}

test.each([250, 150])("epoch keeps the newest 200 items in sequence order from %d retained items", (count) => {
  const items = Array.from({ length: count }, (_, index) => message(index));
  const history: UiSessionHistory = {
    ...common, kind: "transcript", expired: false, summary: null,
    transcript: { stream_epoch: epoch, items, is_truncated: true, live_state, open_text: null },
  };
  const frame = buildEpochFrame({ history, stream_epoch: null, initial_item_window: 200 });
  expect(frame.items).toEqual(items.slice(-200));
  expect(frame.has_earlier).toBe(count > 200);
  expect(frame.stream_epoch).toBe(epoch);
  expect(frame.is_truncated).toBe(true);
  expect(frame.session_state).toBe(live_state);
});

test("unavailable history reports its reason and has empty transcript state", () => {
  const history: UiSessionHistory = {
    ...common, kind: "unavailable", expired: true, summary: null, transcript: null, reason: "agent_history_unavailable",
  };
  expect(buildEpochFrame({ history, stream_epoch: epoch, initial_item_window: 200 })).toEqual({
    kind: "epoch", stream_epoch: epoch, history_kind: "unavailable", expired: true, summary: null,
    unavailable_reason: "agent_history_unavailable", open_turns: [], items: [], session_state: EMPTY_SESSION_LIVE_STATE,
    has_earlier: false, is_truncated: false,
  });
});

test("summary history has no unavailable reason", () => {
  const history: UiSessionHistory = {
    ...common, kind: "summary", expired: true, transcript: null,
    summary: { session_id: sid, schema_version: 1, method: "final_response", markdown: "summary", produced_at: "now", created_at: "now", updated_at: "now" },
  };
  const frame = buildEpochFrame({ history, stream_epoch: null, initial_item_window: 200 });
  expect(frame).not.toHaveProperty("unavailable_reason");
  expect(frame.summary).toBe(history.summary);
});

test("wire frames preserve fold order, report truncation and carry append-only text", () => {
  const item = message(3);
  const state = { kind: "session_state", state: live_state } as const;
  const turn = { kind: "turn_state", turn_key: "operator:one" as TurnKey, state: "idle", stop_reason: null, detail: null } as const;
  const frames: StreamFrame[] = [
    { kind: "item_upsert", item },
    { kind: "item_text", item_id: item.id, seq: item.seq, delta: "more" },
    { kind: "items_evicted", item_ids: [message(0).id], is_truncated: true },
    state, turn,
  ];
  expect(toWireFrames(frames, [message(1), item])).toEqual([
    { kind: "item", item }, { kind: "item_text", id: item.id, delta: "more", is_streaming: true }, { kind: "history_truncated" }, state, turn,
  ]);
});

test("missing and user items have no streaming flag set on their deltas", () => {
  const first = message(0);
  const other = message(1);
  const frames = [first, other].map(({ id, seq }): StreamFrame => ({ kind: "item_text", item_id: id, seq, delta: "more" }));
  expect(toWireFrames(frames, [{ ...other, kind: "user_message", turn_key: null }])).toEqual(
    [first, other].map(({ id }) => ({ kind: "item_text", id, delta: "more", is_streaming: false })),
  );
});

test("a reconnect seeds an older open message on its first delta, then sends append-only deltas", () => {
  const chunk = (messageId: string, text: string): AcpUiEvent => ({
    kind: "agent_message", id: messageId, messageId, content: [{ type: "text", text }], streaming: true, replayed: false,
  });
  let buffer = createTranscriptBuffer({ epoch, capacity: 10 });
  for (const update of [chunk("old", "one"), chunk("new", "newer item"), chunk("old", " two")]) {
    buffer = foldUpdate(buffer, update).buffer;
  }
  const history: UiSessionHistory = {
    ...common, kind: "transcript", expired: false, summary: null,
    transcript: { ...buffer, stream_epoch: epoch },
  };
  const frame = buildEpochFrame({ history, stream_epoch: null, initial_item_window: 1 });
  expect(frame.items.map((item) => item.id)).toEqual([message(1).id]);
  const encode = createSessionFrameEncoder(frame);
  const first = foldUpdate(buffer, chunk("old", " three"));
  const second = foldUpdate(first.buffer, chunk("old", " four"));
  expect(encode(first.frames, first.buffer.items).filter((entry) => entry.kind !== "session_state")).toEqual([
    { kind: "item", item: { ...message(0), text: "one two three", message_id: "old" } },
  ]);
  expect(encode(second.frames, second.buffer.items).filter((entry) => entry.kind !== "session_state")).toEqual([
    { kind: "item_text", id: message(0).id, delta: " four", is_streaming: true },
  ]);
});
