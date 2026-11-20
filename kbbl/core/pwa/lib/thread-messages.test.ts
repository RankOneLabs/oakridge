import { expect, it } from "vitest";
import { permissionRequestId, transcriptItemId, transcriptSeq, type TranscriptItem } from "../../acp/transcript-model";
import type { TurnKey } from "../types";
import { convertTranscriptItem } from "./thread-messages";

const seq = transcriptSeq(1);
const id = transcriptItemId(seq);
const identity = { id, seq };
const message = { ...identity, text: "message", message_id: null, is_replayed: false };

it("converts a user message", () => {
  expect(convertTranscriptItem({ ...message, kind: "user_message", turn_key: null })).toEqual({
    id, role: "user", content: [{ type: "text", text: message.text }],
  });
});

it("converts an agent message with its streaming state", () => {
  const item = { ...message, kind: "agent_message", is_streaming: true } as const;
  expect(convertTranscriptItem(item)).toEqual({
    id, role: "assistant", content: [{ type: "text", text: message.text }], status: { type: "running" },
  });
  expect(convertTranscriptItem({ ...item, is_streaming: false }).status).toEqual({ type: "complete", reason: "stop" });
});

it("converts a thought", () => {
  expect(convertTranscriptItem({ ...message, kind: "thought", is_streaming: false })).toEqual({
    id, role: "assistant", content: [{ type: "reasoning", text: message.text }],
  });
});

it("converts a tool call without a result", () => {
  expect(convertTranscriptItem({
    ...identity, kind: "tool_call", tool_call_id: "call", title: "Tool",
    tool_kind: { is_recognized: false, raw: "custom-tool" },
    status: { is_recognized: true, value: "failed" }, content: [], locations: [],
  })).toEqual({ id, role: "assistant", content: [{ type: "tool-call", toolCallId: "call", toolName: "custom-tool", args: {} }] });
});

const dataItems: TranscriptItem[] = [
  { ...identity, kind: "plan", entries: [] },
  { ...identity, kind: "permission", request_id: permissionRequestId("request"), title: "Allow?", options: [], resolution: null },
  { ...identity, kind: "turn_note", turn_key: "turn" as TurnKey, state: "cancelled", stop_reason: null, detail: null },
];

it.each(dataItems)("converts $kind to a named data part", (item) => {
  expect(convertTranscriptItem(item)).toEqual({
    id, role: "assistant", content: [{ type: "data", name: item.kind, data: item }],
  });
});
