import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EMPTY_SESSION_LIVE_STATE, streamEpoch, transcriptItemId, transcriptSeq, type AgentMessageItem } from "../../acp/transcript-model";
import { getSessionTranscriptStore, selectOrderedItems } from "../state/session-transcript-store";
import type { SessionEpochFrame, SessionWireFrame, TurnKey, UiOpenTurn } from "../types";
import { selectElapsedStartMs, selectQueuedTurns, selectRunningTurn } from "./session-panel";
import { acquireSessionTranscript, type SessionTranscriptHandle } from "./session-transcript-connection";

const { subscriptions } = vi.hoisted(() => ({ subscriptions: [] as FakeSubscription[] }));

class FakeSubscription {
  readonly listeners = new Map<string, (event: MessageEvent<string>) => void>();
  readonly close = vi.fn();
  constructor() { subscriptions.push(this); }
  addEventListener(name: string, receive: (event: MessageEvent<string>) => void) {
    this.listeners.set(name, receive);
  }
  emit(frame: SessionWireFrame) {
    this.listeners.get(frame.kind)?.(new MessageEvent(frame.kind, { data: JSON.stringify(frame) }));
  }
}

vi.mock("./live-stream", () => ({ LiveSubscription: function () { return new FakeSubscription(); } }));

const sid = "test/session";
const handles: SessionTranscriptHandle[] = [];

function acquire() {
  const handle = acquireSessionTranscript(sid);
  handles.push(handle);
  return handle;
}

function item(index: number): AgentMessageItem {
  const seq = transcriptSeq(index);
  return { kind: "agent_message", seq, id: transcriptItemId(seq), message_id: null, text: "a", is_streaming: true, is_replayed: false };
}

const epoch: SessionEpochFrame = {
  kind: "epoch", stream_epoch: streamEpoch("e1"), history_kind: "transcript", expired: false,
  summary: null, open_turns: [], session_state: EMPTY_SESSION_LIVE_STATE,
  items: [item(5)], has_earlier: true, is_truncated: false,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16));
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
});

afterEach(() => {
  for (const handle of handles.splice(0)) handle.release();
  subscriptions.length = 0;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("shares one subscription and applies a create and two deltas in one update in arrival order", () => {
  const first = acquire();
  const second = acquire();
  expect(subscriptions).toHaveLength(1);
  const [subscription] = subscriptions;
  subscription.emit(epoch);
  const store = getSessionTranscriptStore(sid);
  const updates = vi.fn();
  store.subscribe(updates);
  const row = item(6);
  subscription.emit({ kind: "item", item: row });
  subscription.emit({ kind: "item_text", id: row.id, delta: "b", is_streaming: true });
  subscription.emit({ kind: "item_text", id: row.id, delta: "c", is_streaming: false });
  expect(updates).not.toHaveBeenCalled();
  vi.runOnlyPendingTimers();
  expect(updates).toHaveBeenCalledTimes(1);
  expect(store.getState().items_by_id.get(row.id)).toMatchObject({ text: "abc", is_streaming: false });
  first.release();
  expect(subscription.close).not.toHaveBeenCalled();
  second.release();
  expect(subscription.close).toHaveBeenCalledTimes(1);
  const next = acquire();
  expect(getSessionTranscriptStore(sid).getState().history).toBeNull();
  next.release();
});

it("installs epoch synchronously and drops queued or malformed frames", () => {
  acquire();
  const [subscription] = subscriptions;
  subscription.emit({ kind: "item", item: item(10) });
  subscription.emit(epoch);
  const store = getSessionTranscriptStore(sid);
  const snapshot = store.getState();
  expect(selectOrderedItems(snapshot)).toEqual(epoch.items);
  subscription.listeners.get("item")?.(new MessageEvent("item", { data: "{" }));
  vi.runOnlyPendingTimers();
  expect(store.getState()).toBe(snapshot);
});

it("updates the queue and running turn for a prompt accepted after the epoch", () => {
  acquire();
  const [subscription] = subscriptions;
  subscription.emit({ ...epoch, items: [] });
  const store = getSessionTranscriptStore(sid);
  const turn: UiOpenTurn = {
    turnKey: "operator:live" as TurnKey, text: "Run checks", source: "operator",
    status: "accepted", createdAt: "2026-09-02T00:01:00Z",
  };
  const accepted = { kind: "turn_accepted", turn } as const;
  subscription.emit(accepted);
  subscription.emit(accepted);
  vi.runOnlyPendingTimers();
  expect(selectQueuedTurns(store.getState())).toEqual([turn]);

  const transition = { kind: "turn_state", turn_key: turn.turnKey, stop_reason: null, detail: null } as const;
  subscription.emit({ kind: "session_state", state: { ...EMPTY_SESSION_LIVE_STATE, active_turn: turn.turnKey } });
  subscription.emit({ ...transition, state: "prompting" });
  vi.runOnlyPendingTimers();
  expect(selectQueuedTurns(store.getState())).toEqual([]);
  expect(selectRunningTurn(store.getState())).toEqual({ turn_key: turn.turnKey, text: turn.text });
  expect(selectElapsedStartMs(store.getState(), null)).toBe(Date.parse(turn.createdAt));

  subscription.emit({ kind: "session_state", state: EMPTY_SESSION_LIVE_STATE });
  subscription.emit({ ...transition, state: "idle" });
  subscription.emit(accepted);
  vi.runOnlyPendingTimers();
  expect(store.getState().open_turns).toEqual([]);
  expect(selectRunningTurn(store.getState())).toBeNull();
  expect(selectOrderedItems(store.getState())).toEqual([]);
});

it("pages with the first sequence and reconnects without reusing a stale cursor on conflict", async () => {
  const { loadEarlier } = acquire();
  subscriptions[0].emit(epoch);
  const fetchPage = vi.fn()
    .mockResolvedValueOnce(Response.json({ kind: "page", stream_epoch: epoch.stream_epoch, items: [item(2), item(3)], has_earlier: true }))
    .mockResolvedValueOnce(Response.json({ kind: "epoch_changed", stream_epoch: "e2" }, { status: 409 }));
  vi.stubGlobal("fetch", fetchPage);
  const store = getSessionTranscriptStore(sid);
  const loading = loadEarlier();
  expect(store.getState().is_loading_earlier).toBe(true);
  expect(await loadEarlier()).toEqual({ ok: true, value: "noop" });
  expect(await loading).toEqual({ ok: true, value: "loaded" });
  expect(fetchPage.mock.calls[0][0]).toBe("/sessions/test%2Fsession/items?epoch=e1&before_seq=5");
  expect(selectOrderedItems(store.getState()).map(({ seq }) => seq)).toEqual([2, 3, 5]);
  expect(await loadEarlier()).toEqual({ ok: true, value: "epoch_changed" });
  expect(fetchPage.mock.calls[1][0]).toBe("/sessions/test%2Fsession/items?epoch=e1&before_seq=2");
  expect(store.getState()).toMatchObject({ stream_epoch: null, has_earlier: false, is_loading_earlier: false, connection: { status: "connecting" } });
  expect(subscriptions).toHaveLength(2);
  expect(subscriptions[0].close).toHaveBeenCalledTimes(1);
  expect(await loadEarlier()).toEqual({ ok: true, value: "noop" });
  expect(fetchPage).toHaveBeenCalledTimes(2);
});

it("returns the server error and allows retry", async () => {
  const { loadEarlier } = acquire();
  subscriptions[0].emit(epoch);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "history unavailable" }, { status: 503 })));
  expect(await loadEarlier()).toEqual({ ok: false, error: "history unavailable" });
  expect(getSessionTranscriptStore(sid).getState().is_loading_earlier).toBe(false);
});

it.each([epoch.stream_epoch, streamEpoch("e2")])("discards an in-flight page when a snapshot for %s replaces the window", async (nextEpoch) => {
  const { loadEarlier } = acquire();
  subscriptions[0].emit(epoch);
  const response = Promise.withResolvers<Response>();
  vi.stubGlobal("fetch", vi.fn().mockReturnValue(response.promise));
  const pending = loadEarlier();
  const newEpoch = { ...epoch, stream_epoch: nextEpoch, items: [item(7)] };
  subscriptions[0].emit(newEpoch);
  response.resolve(Response.json({ kind: "page", stream_epoch: epoch.stream_epoch, items: [item(2)], has_earlier: false }));
  expect(await pending).toEqual({ ok: true, value: "noop" });
  const state = getSessionTranscriptStore(sid).getState();
  expect(selectOrderedItems(state)).toEqual(newEpoch.items);
  expect(state.is_loading_earlier).toBe(false);
});

it("pages from the snapshot and page boundaries when live items arrive earlier", async () => {
  const { loadEarlier } = acquire();
  const [subscription] = subscriptions;
  subscription.emit(epoch);
  subscription.emit({ kind: "item", item: item(1) });
  vi.runOnlyPendingTimers();
  const response = Promise.withResolvers<Response>();
  const fetchPage = vi.fn()
    .mockReturnValueOnce(response.promise)
    .mockResolvedValueOnce(Response.json({ kind: "page", stream_epoch: epoch.stream_epoch, items: [item(0), item(1)], has_earlier: false }));
  vi.stubGlobal("fetch", fetchPage);
  const pending = loadEarlier();
  expect(fetchPage.mock.calls[0][0]).toBe("/sessions/test%2Fsession/items?epoch=e1&before_seq=5");
  subscription.emit({ kind: "item", item: { ...item(3), text: "live text" } });
  vi.runOnlyPendingTimers();
  const store = getSessionTranscriptStore(sid);
  const liveItem = store.getState().items_by_id.get(item(3).id);
  response.resolve(Response.json({ kind: "page", stream_epoch: epoch.stream_epoch, items: [item(2), item(3), item(4)], has_earlier: true }));
  expect(await pending).toEqual({ ok: true, value: "loaded" });
  expect(selectOrderedItems(store.getState()).map(({ seq }) => seq)).toEqual([1, 2, 3, 4, 5]);
  expect(store.getState().items_by_id.get(item(3).id)).toBe(liveItem);
  expect(await loadEarlier()).toEqual({ ok: true, value: "loaded" });
  expect(fetchPage.mock.calls[1][0]).toBe("/sessions/test%2Fsession/items?epoch=e1&before_seq=2");
  expect(selectOrderedItems(store.getState()).map(({ seq }) => seq)).toEqual([0, 1, 2, 3, 4, 5]);
});
