import type { ThreadMessageLike } from "@assistant-ui/react";
import { openEnumSpelling } from "../../acp/transcript-transforms";
import type { ToolCallItem } from "../../acp/transcript-model";
import type { SessionTranscriptState } from "../state/session-transcript-store";
import type { TranscriptItem } from "../types";

export function convertTranscriptItem(item: TranscriptItem): ThreadMessageLike {
  const { id } = item;
  switch (item.kind) {
    case "user_message":
      return { id, role: "user", content: [{ type: "text", text: item.text }] };
    case "agent_message":
      return {
        id, role: "assistant", content: [{ type: "text", text: item.text }],
        status: item.is_streaming ? { type: "running" } : { type: "complete", reason: "stop" },
      };
    case "thought":
      return { id, role: "assistant", content: [{ type: "reasoning", text: item.text }] };
    case "tool_call":
      return {
        id, role: "assistant",
        content: [{ type: "tool-call", toolCallId: item.tool_call_id, toolName: openEnumSpelling(item.tool_kind), args: {} }],
      };
    case "plan":
    case "permission":
    case "turn_note":
      return { id, role: "assistant", content: [{ type: "data", name: item.kind, data: item }] };
  }
}

const toolsByItems = new WeakMap<SessionTranscriptState["items_by_id"], ReadonlyMap<string, ToolCallItem>>();

export function selectToolItemByCallId({ items_by_id }: SessionTranscriptState, toolCallId: string) {
  let tools = toolsByItems.get(items_by_id);
  if (!tools) {
    const index = new Map<string, ToolCallItem>();
    for (const item of items_by_id.values()) {
      if (item.kind === "tool_call") index.set(item.tool_call_id, item);
    }
    toolsByItems.set(items_by_id, index);
    tools = index;
  }
  return tools.get(toolCallId);
}
