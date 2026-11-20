import { describe, expect, it } from "vitest";
import { permissionRequestId, transcriptItemId, transcriptSeq, type TranscriptItem } from "../../acp/transcript-model";
import type { TurnKey } from "../types";
import { groupConfigOptions, selectTimelineItems } from "./session-items";

describe("groupConfigOptions", () => {
  it("routes semantic categories to named slots and the rest to overflow", () => {
    const grouped = groupConfigOptions([
      { id: "m", name: "Model", category: "model", type: "select", value: "x", options: [] },
      { id: "t", name: "Thinking", category: "thought_level", type: "select", value: "y", options: [] },
      { id: "mode", name: "Mode", category: "mode", type: "select", value: "z", options: [] },
      { id: "other", name: "Verbose", category: null, type: "boolean", value: true, options: [] },
    ]);
    expect(grouped.model?.id).toBe("m");
    expect(grouped.thoughtLevel?.id).toBe("t");
    expect(grouped.mode?.id).toBe("mode");
    expect(grouped.overflow.map((option) => option.id)).toEqual(["other"]);
  });
});


it("maps all transcript variants to the timeline and preserves enum spellings", () => {
  const identity = (index: number) => ({ seq: transcriptSeq(index), id: transcriptItemId(transcriptSeq(index)) });
  const turn = "operator:test" as TurnKey;
  const message = { message_id: null, is_replayed: false };
  const content = [{ type: "terminal", terminal_id: "console" }] as const;
  const locations = [{ path: "file", line: 2 }];
  const permission = {
    kind: "permission", title: "Allow?", request_id: permissionRequestId("perm-1"),
    options: [{ option_id: "yes", name: "Yes", kind: "allow_once" }],
  } as const;
  const items: TranscriptItem[] = [
    { ...identity(0), ...message, kind: "user_message", text: "prompt", turn_key: turn },
    { ...identity(1), ...message, kind: "agent_message", text: "reply", is_streaming: true },
    { ...identity(2), ...message, kind: "thought", text: "consider", is_streaming: false },
    { ...identity(3), kind: "tool_call", tool_call_id: "tool", title: "Run", tool_kind: { is_recognized: true, value: "execute" },
      status: { is_recognized: false, raw: "waiting" }, content, locations },
    { ...identity(4), kind: "plan", entries: [{ content: "step", status: { is_recognized: true, value: "pending" },
      priority: { is_recognized: false, raw: "urgent" } }] },
    { ...identity(5), ...permission, resolution: { kind: "selected", option_id: "yes" } },
    { ...identity(6), ...permission, resolution: { kind: "cancelled" } },
    { ...identity(7), ...permission, resolution: null },
    { ...identity(8), kind: "turn_note", turn_key: turn, state: "failed", stop_reason: null, detail: "details" },
  ];
  const permissionCard = { kind: "permission", requestId: "perm-1", title: "Allow?",
    options: [{ optionId: "yes", name: "Yes", kind: "allow_once" }] };
  expect(selectTimelineItems(items)).toEqual([
    { kind: "user", key: "item-0", text: "prompt" },
    { kind: "agent", key: "item-1", text: "reply", streaming: true },
    { kind: "thought", key: "item-2", text: "consider", streaming: false },
    { kind: "tool", key: "item-3", title: "Run", toolCallId: "tool", status: "waiting", content, locations },
    { kind: "plan", key: "item-4", entries: [{ content: "step", status: "pending", priority: "urgent" }] },
    { ...permissionCard, key: "item-5", resolution: { outcome: "selected", optionId: "yes" } },
    { ...permissionCard, key: "item-6", resolution: { outcome: "cancelled", optionId: null } },
    { ...permissionCard, key: "item-7", resolution: null },
    { kind: "turn_note", key: "item-8", state: "failed", stopReason: null, detail: "details" },
  ]);
});
