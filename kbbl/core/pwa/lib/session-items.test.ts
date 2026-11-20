import { describe, expect, it } from "vitest";
import { EMPTY_SESSION_LIVE_STATE, permissionRequestId, transcriptItemId, transcriptSeq, type PermissionItem, type PlanItem, type TranscriptItem } from "../../acp/transcript-model";
import type { TurnKey } from "../types";
import { groupConfigOptions, selectSessionTimelineItems, selectTimelineItems } from "./session-items";

const identity = (index: number) => ({ seq: transcriptSeq(index), id: transcriptItemId(transcriptSeq(index)) });

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

it("merges the latest plan and open permissions into the timeline once in sequence order", () => {
  const permission = openPermission(0);
  const plan: PlanItem = { ...identity(2), kind: "plan", entries: [] };
  const visible: PlanItem = { ...identity(1), kind: "plan", entries: [] };
  const state = { ...EMPTY_SESSION_LIVE_STATE, latest_plan: plan, open_permissions: [permission] };
  const keys = [permission.id, visible.id, plan.id];
  expect(selectSessionTimelineItems([visible], state).map((item) => item.key)).toEqual(keys);
  expect(selectSessionTimelineItems([permission, visible, plan], state).map((item) => item.key)).toEqual(keys);
});

it("retires an unanswered permission when it leaves live state and preserves recorded outcomes", () => {
  const unanswered = openPermission(0);
  const resolved: PermissionItem = { ...openPermission(1), resolution: { kind: "cancelled" } };
  const items = [unanswered, resolved];
  const state = { ...EMPTY_SESSION_LIVE_STATE, open_permissions: [unanswered] };
  expect(selectSessionTimelineItems(items, state).map((item) => item.key)).toEqual([unanswered.id, resolved.id]);
  expect(selectSessionTimelineItems(items, EMPTY_SESSION_LIVE_STATE)).toMatchObject([
    { key: resolved.id, resolution: { outcome: "cancelled", optionId: null } },
  ]);
});

function openPermission(index: number): PermissionItem {
  return {
    ...identity(index), kind: "permission", title: "Allow?", request_id: permissionRequestId(`perm-${index}`),
    options: [], resolution: null,
  };
}
