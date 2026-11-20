import type { ThreadMessageLike } from "@assistant-ui/react";
import { openEnumSpelling } from "../../acp/transcript-transforms";
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
