import { expect, test } from "bun:test";
import { createTranscriptBuffer, foldUpdate } from "./transcript-fold";
import {
  permissionRequestId, streamEpoch, transcriptItemId, transcriptSeq,
  type TranscriptBuffer, type TranscriptItemId, type TranscriptSeq,
} from "./transcript-model";
import type { AcpUiEvent, TurnKey } from "./types";

const epoch = streamEpoch("test");
const turnKey = "operator:x" as TurnKey;
const content = (text: string) => [{ type: "text" as const, text }];
const itemId = (index: number) => transcriptItemId(transcriptSeq(index));

test("transcript item IDs and sequences require their brands", () => {
  // @ts-expect-error Plain strings are not transcript item IDs.
  const id: TranscriptItemId = "item-0";
  // @ts-expect-error Plain numbers are not transcript sequences.
  const seq: TranscriptSeq = 0;
  expect([id, seq]).toEqual([itemId(0), transcriptSeq(0)]);
});

function agent(text: string, messageId: string | null = null): Extract<AcpUiEvent, { kind: "agent_message" }> {
  return { kind: "agent_message", id: messageId ?? `fallback-${text}`, messageId, content: content(text), streaming: true, replayed: false };
}

function tool(toolCallId: string, status = "completed"): Extract<AcpUiEvent, { kind: "tool_call" }> {
  return { kind: "tool_call", toolCallId, title: `Run ${toolCallId}`, status, content: null };
}

function plan(status: string, text: string): Extract<AcpUiEvent, { kind: "plan" }> {
  return { kind: "plan", entries: [{ content: text, status, priority: "high" }] };
}

const permission: AcpUiEvent = {
  kind: "permission", requestId: "perm-1", title: "Allow write?", options: [{ optionId: "opt", name: "Allow", kind: "allow_once" }],
};

function fold(events: readonly AcpUiEvent[], capacity = 10): TranscriptBuffer {
  return events.reduce((buffer, event) => foldUpdate(buffer, event).buffer, createTranscriptBuffer({ epoch, capacity }));
}

test("a present messageId keeps identified agent chunks in one item and emits an item_text delta", () => {
  const result = foldUpdate(fold([agent("hello ", "m1")]), agent("world", "m1"));
  expect(result.buffer.items).toMatchObject([{ id: itemId(0), seq: transcriptSeq(0), text: "hello world" }]);
  expect(result.frames[0]).toEqual({ kind: "item_text", item_id: itemId(0), seq: transcriptSeq(0), delta: "world" });
});

test("legacy chunks without the optional property use their event IDs", () => {
  const { messageId, ...legacy } = agent("hello", "legacy-id");
  expect(fold([legacy, { ...legacy, content: content(" world") }]).items)
    .toMatchObject([{ message_id: "legacy-id", text: "hello world" }]);
});

test("consecutive chunks with no ACP message ID coalesce regardless of fallback IDs", () => {
  expect(fold([agent("one "), agent("two")]).items).toMatchObject([{ message_id: null, text: "one two" }]);
});

test("a changed ID closes the prior text run before publishing the next item", () => {
  const result = foldUpdate(fold([agent("one", "m1")]), agent("two", "m2"));
  expect(result.frames.slice(0, 2)).toMatchObject([
    { kind: "item_upsert", item: { message_id: "m1", is_streaming: false } },
    { kind: "item_upsert", item: { message_id: "m2", is_streaming: true } },
  ]);
});

test("a changed kind breaks an anonymous text run", () => {
  expect(fold([agent("one"), { ...agent("two"), kind: "thought" }]).items)
    .toMatchObject([{ kind: "agent_message", is_streaming: false }, { kind: "thought", is_streaming: true }]);
});

test("an intervening item breaks an anonymous text run", () => {
  expect(fold([agent("one"), tool("intervening"), agent("two")]).items)
    .toMatchObject([{ text: "one", is_streaming: false }, { kind: "tool_call" }, { text: "two", is_streaming: true }]);
});

test("a retained identified message reopens across an intervening item", () => {
  const result = foldUpdate(fold([agent("one ", "m1"), tool("intervening")]), agent("two", "m1"));
  expect(result.buffer.items).toMatchObject([{ id: itemId(0), text: "one two", is_streaming: true }, { kind: "tool_call" }]);
  expect(result.frames.slice(0, 2)).toMatchObject([
    { kind: "item_text", item_id: itemId(0), seq: transcriptSeq(0), delta: "two" },
    { kind: "item_upsert", item: { id: itemId(0), is_streaming: true } },
  ]);
});

test("a dispatched prompt always gets a separate row and turn key, while replay does not", () => {
  const prompt: AcpUiEvent = { kind: "user_message", id: turnKey, messageId: null, turnKey, content: content("prompt"), replayed: false };
  const replay: AcpUiEvent = { kind: "user_message", id: "chunk", messageId: null, content: content("replay"), replayed: true };
  expect(fold([prompt, replay, prompt]).items).toMatchObject([
    { message_id: null, turn_key: turnKey, text: "prompt", is_replayed: false },
    { message_id: null, turn_key: null, text: "replay", is_replayed: true },
    { message_id: null, turn_key: turnKey, text: "prompt", is_replayed: false },
  ]);
});

test("a tool update keeps the existing call, ID, sequence and nonempty title", () => {
  const started = fold([tool("t1", "in_progress")]);
  const update: AcpUiEvent = {
    ...tool("t1"), title: "",
    delta: { phase: "update", title: "", kind: null, status: "completed", content: [{ type: "terminal", terminalId: "term" }], locations: null },
  };
  expect(foldUpdate(started, update).buffer.items).toMatchObject([{
    id: itemId(0), seq: transcriptSeq(0), title: "Run t1", status: { is_recognized: true, value: "completed" },
    content: [{ type: "terminal", terminal_id: "term" }],
  }]);
});

test("an absent tool update field does not overwrite its prior value", () => {
  const result = fold([
    tool("t", "failed"),
    { ...tool("t", "in_progress"), title: "", delta: { phase: "update", title: null, kind: null, status: null, content: null, locations: null } },
  ]);
  expect(result.items).toMatchObject([{ title: "Run t", status: { is_recognized: true, value: "failed" } }]);
});

test("active tool falls back to the highest-sequence open tool when it completes", () => {
  const started = [tool("old", "pending"), tool("middle", "pending"), tool("new", "in_progress")];
  expect(fold([...started, tool("new")]).live_state.active_tool?.tool_call_id).toBe("middle");
});

test("a new plan replaces the retained plan in place and updates progress", () => {
  const next = foldUpdate(fold([plan("completed", "old")]), plan("in_progress", "new"));
  expect(next.buffer.items).toMatchObject([{ id: itemId(0), seq: transcriptSeq(0), entries: [{ content: "new" }] }]);
  expect(next.buffer.live_state.plan_progress).toEqual({ total: 1, completed: 0, current_entry: "new" });
});

test.each(["selected", "cancelled"] as const)("a %s permission resolves the same item and leaves the pending list", (outcome) => {
  const event: AcpUiEvent = { kind: "permission_resolved", requestId: "perm-1", outcome, ...(outcome === "selected" ? { optionId: "opt" } : {}) };
  const result = foldUpdate(fold([permission]), event);
  const resolution = outcome === "selected" ? { kind: "selected", option_id: "opt" } : { kind: "cancelled" };
  expect(result.buffer.items).toMatchObject([{ id: itemId(0), request_id: "perm-1", resolution }]);
  expect(result.buffer.live_state.open_permissions).toEqual([]);
});

test.each(["cancelled", "failed", "unknown"] as const)("a %s turn adds a note and forwards the turn_state last", (state) => {
  const result = foldUpdate(fold([{ kind: "turn_state", turnKey, state: "prompting" }]), { kind: "turn_state", turnKey, state });
  expect(result.buffer.items).toMatchObject([{ kind: "turn_note", turn_key: turnKey, state, stop_reason: null, detail: null }]);
  expect(result.frames.map((frame) => frame.kind)).toEqual(["item_upsert", "session_state", "turn_state"]);
});

test("prompting and idle change the active turn without adding notes", () => {
  const started = foldUpdate(fold([]), { kind: "turn_state", turnKey, state: "prompting" });
  const stopped = foldUpdate(started.buffer, { kind: "turn_state", turnKey, state: "idle", stopReason: "end_turn" });
  expect(started.buffer.live_state.active_turn).toBe(turnKey);
  expect(stopped.buffer.live_state.active_turn).toBeNull();
  expect(stopped.buffer.items).toEqual([]);
  expect(started.frames.at(-1)).toMatchObject({ kind: "turn_state", state: "prompting" });
  expect(stopped.frames.at(-1)).toMatchObject({ kind: "turn_state", state: "idle", stop_reason: "end_turn" });
});

test("latest-wins events emit full live state without adding items", () => {
  const initial = fold([agent("initial")]);
  const events: AcpUiEvent[] = [
    { kind: "config_options", options: [{ id: "mode", name: "Mode", category: null, type: "boolean", value: true, options: [] }] },
    { kind: "commands", commands: [{ name: "compact", description: null }] },
    { kind: "usage", used: 2 },
    { kind: "session_info", title: "Renamed" },
  ];
  const updated = events.reduce((buffer, event) => {
    const result = foldUpdate(buffer, event);
    expect(result.frames).toEqual([{ kind: "session_state", state: result.buffer.live_state }]);
    expect(result.buffer.items).toBe(initial.items);
    return result.buffer;
  }, initial);
  expect(updated.live_state).toMatchObject({ usage: { used: 2, size: null, cost: null }, session_title: "Renamed", latest_agent_line: { text: "initial" } });
  const unchanged = foldUpdate(updated, { kind: "usage", used: 2 });
  expect(unchanged.buffer.live_state).toBe(updated.live_state);
  expect(unchanged.frames).toEqual([]);
});

test("retention evicts lowest eligible sequences in ascending order and reports truncation", () => {
  let buffer = fold([], 3);
  const evictions = Array.from({ length: 5 }, (_, index) => tool(String(index))).flatMap((event) => {
    const result = foldUpdate(buffer, event);
    buffer = result.buffer;
    return result.frames.filter((frame) => frame.kind === "items_evicted");
  });
  expect(evictions).toEqual([0, 1].map((seq) => ({ kind: "items_evicted", item_ids: [itemId(seq)], is_truncated: true })));
  expect(buffer.items.map((item) => item.seq)).toEqual([2, 3, 4].map(transcriptSeq));
  expect(buffer.is_truncated).toBe(true);
});

test("retention keeps in-progress tools and the current streaming message over an eligible row", () => {
  const result = foldUpdate(fold([tool("protected", "in_progress"), tool("eligible")], 2), agent("streaming"));
  expect(result.buffer.items.map((item) => item.id)).toEqual([itemId(0), itemId(2)]);
  expect(result.frames.filter((frame) => frame.kind === "items_evicted"))
    .toEqual([{ kind: "items_evicted", item_ids: [itemId(1)], is_truncated: true }]);
});

test("when all items are protected, eviction waits until a tool becomes terminal", () => {
  const result = foldUpdate(fold([tool("a", "pending"), tool("b", "in_progress")], 2), tool("c", "pending"));
  expect(result.buffer.items).toHaveLength(3);
  expect(result.frames.some((frame) => frame.kind === "items_evicted")).toBe(false);
  const freed = foldUpdate(result.buffer, tool("b"));
  expect(freed.buffer.items.map((item) => item.id)).toEqual([itemId(0), itemId(2)]);
  expect(freed.frames.map((frame) => frame.kind)).toEqual(["item_upsert", "items_evicted"]);
});

test("an old in-progress tool still receives a title-less update after repeated eviction", () => {
  const buffer = fold([tool("old", "in_progress"), ...Array.from({ length: 6 }, (_, index) => tool(String(index)))], 2);
  const result = foldUpdate(buffer, { ...tool("old"), title: "" });
  expect(result.buffer.items[0]).toMatchObject({ id: itemId(0), title: "Run old", status: { value: "completed" } });
});

test("evicted permission stays open and a late resolution still emits new session state", () => {
  const buffer = fold([permission, tool("overflow")], 1);
  expect(buffer.items.map((item) => item.kind)).toEqual(["tool_call"]);
  expect(buffer.live_state.open_permissions.map((item) => item.request_id)).toEqual([permissionRequestId("perm-1")]);
  const result = foldUpdate(buffer, { kind: "permission_resolved", outcome: "cancelled", requestId: "perm-1" });
  expect(result.frames).toEqual([{ kind: "session_state", state: { ...buffer.live_state, open_permissions: [] } }]);
});

test("latest agent line and plan progress survive source eviction", () => {
  const buffer = fold([
    { ...agent("old\n newest \n  "), replayed: true, streaming: false },
    plan("completed", "task"), tool("overflow"),
  ], 1);
  expect(buffer.items.map((item) => item.kind)).toEqual(["tool_call"]);
  expect(buffer.live_state).toMatchObject({
    latest_agent_line: { item_id: itemId(0), text: "newest" },
    plan_progress: { total: 1, completed: 1, current_entry: null },
  });
});

function freeze<T>(data: T): T {
  if (data && typeof data === "object") {
    for (const value of Object.values(data)) freeze(value);
    Object.freeze(data);
  }
  return data;
}

test("folding a deeply frozen buffer and event is pure and deterministic", () => {
  const buffer = freeze(fold([agent("one"), tool("active", "pending"), agent("two")], 2));
  const event = freeze(agent(" three"));
  expect(foldUpdate(buffer, event)).toEqual(foldUpdate(buffer, event));
});
