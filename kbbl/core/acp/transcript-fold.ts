import { isDeepStrictEqual } from "node:util";
import {
  EMPTY_SESSION_LIVE_STATE, permissionRequestId, transcriptItemId, transcriptSeq,
  type ActiveTool, type FoldResult, type PermissionResolution, type PlanItemEntry,
  type StreamEpoch, type StreamFrame, type ToolCallItem, type TranscriptBuffer, type TranscriptItem,
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

export function createTranscriptBuffer(input: BufferOptions): TranscriptBuffer {
  return { ...input, items: [], next_seq: transcriptSeq(0), is_truncated: false, live_state: EMPTY_SESSION_LIVE_STATE, open_text: null };
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

function updateAgentLine(buffer: TranscriptBuffer, item: TextItem): TranscriptBuffer {
  if (item.kind !== "agent_message") return buffer;
  const trimmed = item.text.trimEnd();
  const text = trimmed.slice(trimmed.lastIndexOf("\n") + 1).trimStart();
  if (text === "") return buffer;
  return { ...buffer, live_state: { ...buffer.live_state, latest_agent_line: { item_id: item.id, text } } };
}

function foldMessageChunk(buffer: TranscriptBuffer, event: MessageChunk): FoldResult {
  const draft = messageDraft(event);
  const isPrompt = draft.kind === "user_message" && draft.turn_key !== null;
  const previous = isPrompt ? undefined : findTextItem(buffer, draft);
  const isSameRun = previous !== undefined && previous.id === buffer.open_text?.item_id;
  const closed = isSameRun ? { buffer, frames: [] } : closeOpenText(buffer);

  let next: TranscriptBuffer;
  let item: TextItem;
  const frames: StreamFrame[] = [...closed.frames];
  if (previous) {
    item = { ...draft, id: previous.id, seq: previous.seq, text: previous.text + draft.text };
    next = replaceItem(closed.buffer, item);
    frames.push({ kind: "item_text", item_id: item.id, seq: item.seq, delta: draft.text });
    // A text delta cannot transmit changes in streaming or replay metadata.
    if (previous.is_replayed !== item.is_replayed ||
      ("is_streaming" in item && "is_streaming" in previous && item.is_streaming !== previous.is_streaming)) {
      frames.push({ kind: "item_upsert", item });
    }
  } else {
    const appended = appendItem(closed.buffer, draft);
    next = appended.buffer;
    item = appended.item;
    frames.push({ kind: "item_upsert", item });
  }
  const open_text = isPrompt ? null : { item_id: item.id, kind: item.kind, message_id: item.message_id };
  return { buffer: updateAgentLine({ ...next, open_text }, item), frames };
}

function isOpenTool(item: TranscriptItem): boolean {
  return item.kind === "tool_call" && item.status.is_recognized &&
    (item.status.value === "pending" || item.status.value === "in_progress");
}

function activeToolFromItem(item: ToolCallItem): ActiveTool {
  return { item_id: item.id, tool_call_id: item.tool_call_id, title: item.title, tool_kind: item.tool_kind, status: item.status };
}

function deriveActiveTool(buffer: TranscriptBuffer, item: ToolCallItem): ActiveTool | null {
  if (isOpenTool(item)) return activeToolFromItem(item);
  const active = buffer.live_state.active_tool;
  if (active?.item_id !== item.id) return active;
  const newest = buffer.items.findLast((candidate): candidate is ToolCallItem => candidate.kind === "tool_call" && isOpenTool(candidate));
  return newest ? activeToolFromItem(newest) : null;
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
  const active_tool = deriveActiveTool(stored.buffer, stored.item);
  return {
    buffer: { ...stored.buffer, live_state: { ...buffer.live_state, active_tool } },
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
    buffer: { ...stored.buffer, live_state: { ...buffer.live_state, plan_progress } },
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
  const next = { ...buffer, live_state: { ...buffer.live_state, active_turn: state === "prompting" ? turn_key : null } };
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
      return { buffer: { ...buffer, live_state: { ...state, session_title: event.title ?? null } }, frames: [] };
  }
}

function preservesOpenItem(item: TranscriptItem): boolean {
  return isOpenTool(item) || ((item.kind === "agent_message" || item.kind === "thought") && item.is_streaming);
}

function evictOverflow(buffer: TranscriptBuffer): FoldResult {
  const overflow = buffer.items.length - buffer.capacity;
  if (overflow <= 0) return { buffer, frames: [] };
  const item_ids: TranscriptItem["id"][] = [];
  const items = buffer.items.filter((item) => {
    if (item_ids.length === overflow || preservesOpenItem(item)) return true;
    item_ids.push(item.id);
    return false;
  });
  if (item_ids.length === 0) return { buffer, frames: [] };
  const open_text = buffer.open_text && item_ids.includes(buffer.open_text.item_id) ? null : buffer.open_text;
  return {
    buffer: { ...buffer, items, open_text, is_truncated: true },
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
  const changed = !isDeepStrictEqual(buffer.live_state, retained.buffer.live_state);
  const live_state = changed ? retained.buffer.live_state : buffer.live_state;
  if (changed) frames.push({ kind: "session_state", state: live_state });
  if (event.kind === "turn_state") frames.push(turnFrame(event));
  return { buffer: { ...retained.buffer, live_state }, frames };
}
