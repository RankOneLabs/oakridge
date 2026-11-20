import type { ToolContent, TranscriptItem, TranscriptSnapshot } from "./transcript-model";
import { openEnumSpelling } from "./transcript-transforms";
import type { AcpUiEvent } from "./types";

export function toWireEvent(event: AcpUiEvent): AcpUiEvent {
  switch (event.kind) {
    case "user_message": {
      const { messageId, turnKey, ...wire } = event;
      return wire;
    }
    case "agent_message":
    case "thought": {
      const { messageId, ...wire } = event;
      return wire;
    }
    case "tool_call": {
      const { delta, ...wire } = event;
      return wire;
    }
    default:
      return { ...event };
  }
}

function renderToolContent(block: ToolContent) {
  switch (block.type) {
    case "text": return { type: "content", content: { type: "text", text: block.text } };
    case "diff": return { type: "diff", path: block.path, oldText: block.old_text, newText: block.new_text };
    case "terminal": return { type: "terminal", terminalId: block.terminal_id };
    case "unsupported": return { type: "content", content: { type: block.acp_type } };
  }
}

function renderItem(item: TranscriptItem): AcpUiEvent[] {
  switch (item.kind) {
    case "user_message":
      return [{
        kind: item.kind, id: item.turn_key ?? item.message_id ?? item.id,
        content: [{ type: "text", text: item.text }], replayed: item.is_replayed,
      }];
    case "agent_message":
    case "thought":
      return [{
        kind: item.kind, id: item.message_id ?? item.id,
        content: [{ type: "text", text: item.text }], streaming: item.is_streaming, replayed: item.is_replayed,
      }];
    case "tool_call":
      return [{
        kind: item.kind, toolCallId: item.tool_call_id, title: item.title, status: openEnumSpelling(item.status),
        content: item.content.length ? item.content.map(renderToolContent) : null, locations: item.locations,
      }];
    case "plan":
      return [{
        kind: item.kind,
        entries: item.entries.map(({ content, status, priority }) => ({
          content, status: openEnumSpelling(status), priority: openEnumSpelling(priority),
        })),
      }];
    case "permission": {
      const events: AcpUiEvent[] = [{
        kind: item.kind, requestId: item.request_id, title: item.title,
        options: item.options.map(({ option_id, name, kind }) => ({ optionId: option_id, name, kind })),
      }];
      if (item.resolution?.kind === "selected") {
        events.push({ kind: "permission_resolved", requestId: item.request_id, outcome: "selected", optionId: item.resolution.option_id });
      } else if (item.resolution?.kind === "cancelled") {
        events.push({ kind: "permission_resolved", requestId: item.request_id, outcome: "cancelled" });
      }
      return events;
    }
    case "turn_note":
      return [{
        kind: "turn_state", turnKey: item.turn_key, state: item.state,
        ...(item.stop_reason === null ? {} : { stopReason: item.stop_reason }),
        ...(item.detail === null ? {} : { detail: item.detail }),
      }];
  }
}

export function renderLegacyEvents(snapshot: TranscriptSnapshot | null): AcpUiEvent[] {
  if (snapshot === null) return [];
  const { live_state: state } = snapshot;
  const openItem = snapshot.items.find((item) => item.id === snapshot.open_text?.item_id);
  // An identified streaming item can absorb the next live chunk only if the
  // legacy timeline sees it after the last structural replay event.
  const continuingRun = (openItem?.kind === "agent_message" || openItem?.kind === "thought") &&
    openItem.is_streaming && openItem.message_id !== null ? openItem : null;
  const events = snapshot.items.filter((item) => item !== continuingRun).flatMap(renderItem);
  // An outstanding permission can outlive its retained row. The legacy UI
  // still needs its request event to offer the operator a response.
  const retainedIds = new Set(snapshot.items.map((item) => item.id));
  events.push(...state.open_permissions.filter((item) => !retainedIds.has(item.id)).flatMap(renderItem));
  if (state.latest_plan && !retainedIds.has(state.latest_plan.id)) events.push(...renderItem(state.latest_plan));
  events.push({ kind: "config_options", options: state.config_options });
  events.push({ kind: "commands", commands: state.commands });
  if (state.usage) {
    events.push({
      kind: "usage",
      used: state.usage.used ?? undefined,
      size: state.usage.size ?? undefined,
      cost: state.usage.cost ?? undefined,
    });
  }
  if (state.session_title !== null) events.push({ kind: "session_info", title: state.session_title });
  if (state.active_turn !== null) events.push({ kind: "turn_state", turnKey: state.active_turn, state: "prompting" });
  if (continuingRun) events.push(...renderItem(continuingRun));
  return events;
}
