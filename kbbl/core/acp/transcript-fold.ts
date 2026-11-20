import { isDeepStrictEqual } from "node:util";
import {
  EMPTY_SESSION_LIVE_STATE, permissionRequestId, transcriptItemId, transcriptSeq,
  type ActiveTool, type AgentLineCursor, type FoldResult, type PermissionResolution, type PlanItemEntry,
  type RetainedText, type StreamEpoch, type StreamFrame, type ToolCallItem, type TranscriptBuffer, type TranscriptItem,
} from "./transcript-model";
import {
  projectPermissionOptionKind, projectPlanEntryStatus, projectPlanPriority,
  projectToolContent, projectToolKind, projectToolStatus,
} from "./transcript-transforms";
import type { AcpUiEvent, UiToolCallDelta } from "./types";

interface BufferOptions {
  readonly epoch: StreamEpoch;
  readonly capacity: number;
}

type EventOf<K extends AcpUiEvent["kind"]> = Extract<AcpUiEvent, { kind: K }>;
type TextItem = Extract<TranscriptItem, { kind: "user_message" | "agent_message" | "thought" }>;
type MessageChunk = EventOf<TextItem["kind"]>;
type LiveValue = EventOf<"config_options" | "commands" | "usage" | "session_info">;
type ItemDraft = { [K in TranscriptItem["kind"]]: Omit<Extract<TranscriptItem, { kind: K }>, "id" | "seq"> }[TranscriptItem["kind"]];

const MAX_TEXT_BYTES = 256 * 1024;

export function createTranscriptBuffer(input: BufferOptions): TranscriptBuffer {
  return {
    ...input, items: [], next_seq: transcriptSeq(0), is_truncated: false,
    live_state: EMPTY_SESSION_LIVE_STATE, open_text: null, retained_text: {}, tool_turns: {},
  };
}

function replaceItem(buffer: TranscriptBuffer, item: TranscriptItem): TranscriptBuffer {
  return { ...buffer, items: buffer.items.map((previous) => previous.id === item.id ? item : previous) };
}

function appendItem<T extends ItemDraft>(buffer: TranscriptBuffer, draft: T) {
  const seq = buffer.next_seq;
  const item = { ...draft, id: transcriptItemId(seq), seq };
  return {
    buffer: { ...buffer, items: [...buffer.items, item], next_seq: transcriptSeq(seq + 1) },
    item,
  };
}

function closeOpenText(buffer: TranscriptBuffer): FoldResult {
  if (!buffer.open_text) return { buffer, frames: [] };
  const item = buffer.items.find((candidate) => candidate.id === buffer.open_text?.item_id);
  const closed = { ...buffer, open_text: null };
  if ((item?.kind !== "agent_message" && item?.kind !== "thought") || !item.is_streaming) {
    return { buffer: closed, frames: [] };
  }
  const updated = { ...item, is_streaming: false };
  return { buffer: replaceItem(closed, updated), frames: [{ kind: "item_upsert", item: updated }] };
}

function findTextItem(buffer: TranscriptBuffer, draft: Extract<ItemDraft, { kind: TextItem["kind"] }>): TextItem | undefined {
  return buffer.items.find((item): item is TextItem => (
    item.kind === draft.kind && (draft.message_id !== null
      ? item.message_id === draft.message_id
      : item.id === buffer.open_text?.item_id && buffer.open_text.message_id === null)
  ));
}

function messageDraft(event: MessageChunk): Extract<ItemDraft, { kind: TextItem["kind"] }> {
  const text = event.content.map((part) => part.text).join("");
  const message_id = event.messageId === undefined ? event.id : event.messageId;
  const fields = { message_id, text, is_replayed: event.replayed };
  if (event.kind === "user_message") {
    const turn_key = event.turnKey ?? null;
    return { ...fields, kind: event.kind, turn_key, message_id: turn_key === null ? message_id : null };
  }
  return { ...fields, kind: event.kind, is_streaming: !event.replayed };
}

function advanceAgentLine(previous: AgentLineCursor | null, delta: string): AgentLineCursor {
  const trimmed = delta.trimEnd();
  if (!trimmed) {
    const latest_line = previous?.latest_line ?? "";
    const trailing_whitespace = delta.includes("\n") || previous?.trailing_whitespace == null
      ? null : previous.trailing_whitespace + delta;
    return { latest_line, trailing_whitespace };
  }
  const breakBeforeText = trimmed.lastIndexOf("\n");
  const latest_line = breakBeforeText === -1 && previous?.trailing_whitespace != null
    ? previous.latest_line + previous.trailing_whitespace + trimmed
    : trimmed.slice(breakBeforeText + 1).trimStart();
  const trailing_whitespace = delta.lastIndexOf("\n") >= trimmed.length ? null : delta.slice(trimmed.length);
  return { latest_line, trailing_whitespace };
}

interface TextAppend {
  readonly text: string;
  readonly retained: RetainedText;
  readonly clipped: boolean;
}

function appendText(previous: TextItem | undefined, retained: RetainedText | undefined, draft: Extract<ItemDraft, { kind: TextItem["kind"] }>): TextAppend {
  const prefix = previous?.text ?? "";
  const delta = draft.text;
  let text = prefix + delta;
  let bytes = (retained?.bytes ?? 0) + Buffer.byteLength(delta);
  // Two UTF-16 surrogate halves arriving in separate chunks now encode as one code point.
  const low = delta.charCodeAt(0);
  if (retained?.ends_with_high_surrogate && low >= 0xdc00 && low <= 0xdfff) bytes -= 2;
  const last = delta.charCodeAt(delta.length - 1);
  const ends_with_high_surrogate = delta.length === 0
    ? retained?.ends_with_high_surrogate ?? false
    : last >= 0xd800 && last <= 0xdbff;
  const clipped = bytes > MAX_TEXT_BYTES;
  if (clipped) {
    let cut = 0;
    while (bytes > MAX_TEXT_BYTES) {
      const codePoint = text.codePointAt(cut)!;
      bytes -= codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
      cut += codePoint < 0x10000 ? 1 : 2;
    }
    // Copy the suffix so it cannot keep the discarded prefix's backing storage alive.
    text = Buffer.from(text.slice(cut), "utf16le").toString("utf16le");
  }
  const agent_line = draft.kind === "agent_message"
    ? advanceAgentLine(clipped ? null : retained?.agent_line ?? null, clipped ? text : delta)
    : null;
  return { text, retained: { bytes, ends_with_high_surrogate, agent_line }, clipped };
}

function foldMessageChunk(buffer: TranscriptBuffer, event: MessageChunk): FoldResult {
  const draft = messageDraft(event);
  const isPrompt = draft.kind === "user_message" && draft.turn_key !== null;
  const previous = isPrompt ? undefined : findTextItem(buffer, draft);
  const isSameRun = previous !== undefined && previous.id === buffer.open_text?.item_id;
  const closed = isSameRun ? { buffer, frames: [] } : closeOpenText(buffer);
  const appendedText = appendText(previous, previous && buffer.retained_text[previous.id], draft);

  let next: TranscriptBuffer;
  let item: TextItem;
  const frames: StreamFrame[] = [...closed.frames];
  if (previous) {
    item = { ...draft, id: previous.id, seq: previous.seq, text: appendedText.text };
    next = replaceItem(closed.buffer, item);
    if (!appendedText.clipped) frames.push({ kind: "item_text", item_id: item.id, seq: item.seq, delta: draft.text });
    // A text delta cannot transmit changes in streaming or replay metadata.
    if (appendedText.clipped || previous.is_replayed !== item.is_replayed ||
      ("is_streaming" in item && "is_streaming" in previous && item.is_streaming !== previous.is_streaming)) {
      frames.push({ kind: "item_upsert", item });
    }
  } else {
    const appended = appendItem(closed.buffer, { ...draft, text: appendedText.text });
    next = appended.buffer;
    item = appended.item;
    frames.push({ kind: "item_upsert", item });
  }
  const open_text = isPrompt ? null : { item_id: item.id, kind: item.kind, message_id: item.message_id };
  const line = appendedText.retained.agent_line?.latest_line;
  const live_state = line
    ? { ...next.live_state, latest_agent_line: { item_id: item.id, text: line } }
    : next.live_state;
  return {
    buffer: {
      ...next, open_text, live_state, is_truncated: next.is_truncated || appendedText.clipped,
      retained_text: { ...next.retained_text, [item.id]: appendedText.retained },
    },
    frames,
  };
}

function isOpenTool(item: TranscriptItem): boolean {
  return item.kind === "tool_call" && item.status.is_recognized &&
    (item.status.value === "pending" || item.status.value === "in_progress");
}

function isActiveTool(buffer: TranscriptBuffer, item: TranscriptItem): boolean {
  const turn = buffer.tool_turns[item.id];
  return isOpenTool(item) && (turn === null || turn === buffer.live_state.active_turn);
}

function activeToolFromItem(item: ToolCallItem): ActiveTool {
  return { item_id: item.id, tool_call_id: item.tool_call_id, title: item.title, tool_kind: item.tool_kind, status: item.status };
}

function deriveActiveTool(buffer: TranscriptBuffer, item: ToolCallItem): ActiveTool | null {
  if (isActiveTool(buffer, item)) return activeToolFromItem(item);
  const active = buffer.live_state.active_tool;
  if (active?.item_id !== item.id) return active;
  return newestActiveTool(buffer);
}

function newestActiveTool(buffer: TranscriptBuffer): ActiveTool | null {
  const newest = buffer.items.findLast((item) => isActiveTool(buffer, item));
  return newest?.kind === "tool_call" ? activeToolFromItem(newest) : null;
}

function foldToolCall(buffer: TranscriptBuffer, event: EventOf<"tool_call">): FoldResult {
  const previous = buffer.items.find((item): item is ToolCallItem => (
    item.kind === "tool_call" && item.tool_call_id === event.toolCallId
  ));
  const delta: UiToolCallDelta = event.delta ?? {
    phase: previous ? "update" : "create",
    title: event.title || null,
    kind: null,
    status: event.status,
    content: Array.isArray(event.content) ? event.content : null,
    locations: event.locations ?? null,
  };
  const draft = {
    kind: "tool_call" as const,
    tool_call_id: event.toolCallId,
    title: delta.title || previous?.title || "",
    tool_kind: delta.kind === null && previous ? previous.tool_kind : projectToolKind(delta.kind ?? "other"),
    status: delta.status === null && previous ? previous.status : projectToolStatus(delta.status ?? "pending"),
    content: delta.content === null && previous ? previous.content : projectToolContent(delta.content),
    locations: delta.locations ?? previous?.locations ?? [],
  };
  const stored = previous
    ? { buffer: replaceItem(buffer, { ...previous, ...draft }), item: { ...previous, ...draft } }
    : appendItem(buffer, draft);
  // After eviction an update without a row may belong to a retired call.
  // Keep the update visible without treating it as a fresh active tool.
  const isOrphanUpdate = event.delta?.phase === "update" && buffer.items.length < buffer.next_seq;
  const tool_turns = previous || isOrphanUpdate
    ? buffer.tool_turns
    : { ...buffer.tool_turns, [stored.item.id]: buffer.live_state.active_turn };
  const next = { ...stored.buffer, tool_turns };
  const active_tool = deriveActiveTool(next, stored.item);
  return {
    buffer: { ...next, live_state: { ...buffer.live_state, active_tool } },
    frames: [{ kind: "item_upsert", item: stored.item }],
  };
}

function foldPlan(buffer: TranscriptBuffer, event: EventOf<"plan">): FoldResult {
  const entries: readonly PlanItemEntry[] = event.entries.map((entry) => ({
    content: entry.content,
    status: projectPlanEntryStatus(entry.status),
    priority: projectPlanPriority(entry.priority),
  }));
  const previous = buffer.items.find((item) => item.kind === "plan");
  const stored = previous
    ? { buffer: replaceItem(buffer, { ...previous, entries }), item: { ...previous, entries } }
    : appendItem(buffer, { kind: "plan", entries });
  const plan_progress = {
    total: entries.length,
    completed: entries.filter(({ status }) => status.is_recognized && status.value === "completed").length,
    current_entry: entries.find(({ status }) => status.is_recognized && status.value === "in_progress")?.content ?? null,
  };
  return {
    buffer: { ...stored.buffer, live_state: { ...buffer.live_state, plan_progress, latest_plan: stored.item } },
    frames: [{ kind: "item_upsert", item: stored.item }],
  };
}

function foldPermission(buffer: TranscriptBuffer, event: EventOf<"permission">): FoldResult {
  const stored = appendItem(buffer, {
    kind: "permission",
    request_id: permissionRequestId(event.requestId),
    title: event.title,
    options: event.options.map((option) => ({
      option_id: option.optionId,
      name: option.name,
      kind: projectPermissionOptionKind(option.kind),
    })),
    resolution: null,
  });
  const open_permissions = [...buffer.live_state.open_permissions, stored.item];
  return {
    buffer: { ...stored.buffer, live_state: { ...buffer.live_state, open_permissions } },
    frames: [{ kind: "item_upsert", item: stored.item }],
  };
}

function foldPermissionResolved(buffer: TranscriptBuffer, event: EventOf<"permission_resolved">): FoldResult {
  const previous = buffer.items.find((item) => item.kind === "permission" && item.request_id === event.requestId);
  const open_permissions = buffer.live_state.open_permissions.filter((item) => item.request_id !== event.requestId);
  const next = { ...buffer, live_state: { ...buffer.live_state, open_permissions } };
  if (!previous) return { buffer: next, frames: [] };
  const resolution: PermissionResolution = event.outcome === "selected" && event.optionId !== undefined
    ? { kind: "selected", option_id: event.optionId }
    : { kind: "cancelled" };
  const item = { ...previous, resolution };
  return { buffer: replaceItem(next, item), frames: [{ kind: "item_upsert", item }] };
}

function turnFrame(event: EventOf<"turn_state">): Extract<StreamFrame, { kind: "turn_state" }> {
  return {
    kind: "turn_state", turn_key: event.turnKey, state: event.state,
    stop_reason: event.stopReason ?? null, detail: event.detail ?? null,
  };
}

function foldTurnState(buffer: TranscriptBuffer, event: EventOf<"turn_state">): FoldResult {
  const { turn_key, state, stop_reason, detail } = turnFrame(event);
  const active_turn = state === "prompting" ? turn_key : null;
  const updatedTurn = { ...buffer, live_state: { ...buffer.live_state, active_turn } };
  const active = buffer.live_state.active_tool;
  const owner = active ? buffer.tool_turns[active.item_id] : null;
  const next = owner === null || owner === active_turn ? updatedTurn : {
    ...updatedTurn, live_state: { ...updatedTurn.live_state, active_tool: newestActiveTool(updatedTurn) },
  };
  if (state === "prompting" || state === "idle") return { buffer: next, frames: [] };
  const stored = appendItem(next, { kind: "turn_note", turn_key, state, stop_reason, detail });
  return { buffer: stored.buffer, frames: [{ kind: "item_upsert", item: stored.item }] };
}

function foldLiveValue(buffer: TranscriptBuffer, event: LiveValue): FoldResult {
  const state = buffer.live_state;
  switch (event.kind) {
    case "config_options":
      return { buffer: { ...buffer, live_state: { ...state, config_options: event.options } }, frames: [] };
    case "commands":
      return { buffer: { ...buffer, live_state: { ...state, commands: event.commands } }, frames: [] };
    case "usage": {
      const usage = { used: event.used ?? null, size: event.size ?? null, cost: event.cost ?? null };
      return { buffer: { ...buffer, live_state: { ...state, usage } }, frames: [] };
    }
    case "session_info":
      return { buffer: { ...buffer, live_state: { ...state, session_title: event.title ?? state.session_title } }, frames: [] };
  }
}

function preservesOpenItem(buffer: TranscriptBuffer, item: TranscriptItem): boolean {
  return item.id === buffer.open_text?.item_id || isActiveTool(buffer, item);
}

function evictOverflow(buffer: TranscriptBuffer): FoldResult {
  const overflow = buffer.items.length - buffer.capacity;
  if (overflow <= 0) return { buffer, frames: [] };
  const item_ids: TranscriptItem["id"][] = [];
  const items = buffer.items.filter((item) => {
    if (item_ids.length === overflow || preservesOpenItem(buffer, item)) return true;
    item_ids.push(item.id);
    return false;
  });
  if (item_ids.length === 0) return { buffer, frames: [] };
  const retained_text = { ...buffer.retained_text };
  const tool_turns = { ...buffer.tool_turns };
  for (const id of item_ids) {
    delete retained_text[id];
    delete tool_turns[id];
  }
  return {
    buffer: { ...buffer, items, retained_text, tool_turns, is_truncated: true },
    frames: [{ kind: "items_evicted", item_ids, is_truncated: true }],
  };
}

function foldEvent(buffer: TranscriptBuffer, event: AcpUiEvent): FoldResult {
  switch (event.kind) {
    case "user_message":
    case "agent_message":
    case "thought":
      return foldMessageChunk(buffer, event);
    case "config_options":
    case "commands":
    case "usage":
    case "session_info":
      return foldLiveValue(buffer, event);
  }

  const closed = closeOpenText(buffer);
  const updated = foldStructuredEvent(closed.buffer, event);
  return { buffer: updated.buffer, frames: [...closed.frames, ...updated.frames] };
}

function foldStructuredEvent(buffer: TranscriptBuffer, event: EventOf<"tool_call" | "plan" | "permission" | "permission_resolved" | "turn_state">): FoldResult {
  switch (event.kind) {
    case "tool_call": return foldToolCall(buffer, event);
    case "plan": return foldPlan(buffer, event);
    case "permission": return foldPermission(buffer, event);
    case "permission_resolved": return foldPermissionResolved(buffer, event);
    case "turn_state": return foldTurnState(buffer, event);
  }
}

export function foldUpdate(buffer: TranscriptBuffer, event: AcpUiEvent): FoldResult {
  const updated = foldEvent(buffer, event);
  const retained = evictOverflow(updated.buffer);
  const frames = [...updated.frames, ...retained.frames];
  if (!buffer.is_truncated && updated.buffer.is_truncated && retained.frames.length === 0) {
    // A text prefix can be discarded without evicting an item.
    frames.push({ kind: "items_evicted", item_ids: [], is_truncated: true });
  }
  const changed = !isDeepStrictEqual(buffer.live_state, retained.buffer.live_state);
  const live_state = changed ? retained.buffer.live_state : buffer.live_state;
  if (changed) frames.push({ kind: "session_state", state: live_state });
  if (event.kind === "turn_state") frames.push(turnFrame(event));
  return { buffer: { ...retained.buffer, live_state }, frames };
}
